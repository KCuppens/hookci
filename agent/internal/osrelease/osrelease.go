// Package osrelease names the operating system the agent runs on as a short
// printable string such as "Ubuntu 22.04", "macOS 14.5" or "Windows 11". The
// agent sends it in its hello frame so the dashboard can show it.
//
// Everything that touches the machine sits behind Source, so tests supply the
// file and command output and never exec.
package osrelease

import (
	"bufio"
	"bytes"
	"context"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// MaxLen is the longest os_release the hub accepts, in characters.
const MaxLen = 64

// commandTimeout bounds each command Detect runs, so a hung sw_vers or ver
// cannot stall the agent's first hello.
const commandTimeout = 3 * time.Second

// Source is what Detect reads from the machine.
type Source interface {
	// GOOS is the runtime.GOOS value: linux, darwin or windows.
	GOOS() string
	// ReadFile returns the contents of the named file.
	ReadFile(name string) ([]byte, error)
	// Output runs the command and returns its standard output.
	Output(name string, args ...string) ([]byte, error)
}

// System is the Source for the machine the agent runs on.
type System struct {
	// OS is the runtime.GOOS value to report.
	OS string
}

// GOOS returns the operating system name System was built for.
func (s System) GOOS() string { return s.OS }

// ReadFile reads the named file.
func (System) ReadFile(name string) ([]byte, error) { return os.ReadFile(name) }

// Output runs the command with a short timeout.
func (System) Output(name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).Output()
}

// Detect returns the operating system name for src, or "" when it cannot be
// told. The result is printable, trimmed and at most MaxLen characters.
func Detect(src Source) string {
	switch src.GOOS() {
	case "linux":
		return Sanitize(linux(src))
	case "darwin":
		return Sanitize(darwin(src))
	case "windows":
		return Sanitize(windows(src))
	default:
		return ""
	}
}

// Sanitize drops anything unprintable, collapses whitespace and cuts s to
// MaxLen characters.
func Sanitize(s string) string {
	var b strings.Builder
	n := 0
	pendingSpace := false
	for _, r := range strings.ToValidUTF8(s, "") {
		if unicode.IsSpace(r) {
			pendingSpace = b.Len() > 0
			continue
		}
		if !unicode.IsPrint(r) {
			continue
		}
		if pendingSpace {
			if n+1 >= MaxLen {
				break
			}
			b.WriteByte(' ')
			n++
			pendingSpace = false
		}
		if n >= MaxLen {
			break
		}
		b.WriteRune(r)
		n++
	}
	return b.String()
}

var (
	patchVersion = regexp.MustCompile(`\b(\d+\.\d+)\.\d+(?:\.\d+)*\b`)
	ltsSuffix    = regexp.MustCompile(`(?i)\s+LTS\b`)
)

// trimRelease drops the patch part of a version and any LTS marker:
// "Ubuntu 22.04.4 LTS" becomes "Ubuntu 22.04".
func trimRelease(s string) string {
	s = ltsSuffix.ReplaceAllString(s, "")
	return strings.TrimSpace(patchVersion.ReplaceAllString(s, "$1"))
}

func linux(src Source) string {
	data, err := src.ReadFile("/etc/os-release")
	if err != nil {
		return ""
	}
	kv := parseOSRelease(data)
	if pretty := trimRelease(kv["PRETTY_NAME"]); pretty != "" {
		return pretty
	}
	name := kv["NAME"]
	if name == "" {
		name = kv["ID"]
	}
	return trimRelease(strings.TrimSpace(name + " " + kv["VERSION_ID"]))
}

// parseOSRelease reads the KEY=value lines of an os-release file, unquoting
// values.
func parseOSRelease(data []byte) map[string]string {
	out := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		key, val, ok := strings.Cut(line, "=")
		if !ok || strings.HasPrefix(line, "#") {
			continue
		}
		val = strings.TrimSpace(val)
		if len(val) >= 2 && (val[0] == '"' || val[0] == '\'') && val[len(val)-1] == val[0] {
			val = val[1 : len(val)-1]
		}
		out[strings.TrimSpace(key)] = val
	}
	return out
}

func darwin(src Source) string {
	name, err := src.Output("sw_vers", "-productName")
	if err != nil {
		return ""
	}
	ver, err := src.Output("sw_vers", "-productVersion")
	if err != nil {
		return ""
	}
	return trimRelease(strings.TrimSpace(string(name)) + " " + strings.TrimSpace(string(ver)))
}

var windowsVersion = regexp.MustCompile(`\[\S+ (\d+)\.(\d+)\.(\d+)(?:\.\d+)?\]`)

// windowsFirst11Build is the first build number of Windows 11; it reports
// version 10.0 like Windows 10 does.
const windowsFirst11Build = 22000

func windows(src Source) string {
	out, err := src.Output("cmd", "/c", "ver")
	if err != nil {
		return ""
	}
	m := windowsVersion.FindStringSubmatch(string(out))
	if m == nil {
		return ""
	}
	if m[1] == "10" && m[2] == "0" {
		build, err := strconv.Atoi(m[3])
		if err == nil && build >= windowsFirst11Build {
			return "Windows 11"
		}
		return "Windows 10"
	}
	return "Windows " + m[1] + "." + m[2] + "." + m[3]
}
