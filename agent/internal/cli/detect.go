package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/KCuppens/hookci/agent/internal/compat"
	"github.com/KCuppens/hookci/agent/internal/detect"
)

const noChecksMessage = "no checks detected: add .hookci.yml (run hookci init)"

func runDetect(_ context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("detect", flag.ContinueOnError)
	fs.SetOutput(stderr)
	asJSON := fs.Bool("json", false, "print the resolved config as JSON instead of YAML")
	fs.Usage = func() {
		fmt.Fprintln(stdout, "Usage: hookci detect [dir] [flags]")
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Infer checks from the project files in dir (default .) and print them as .hookci.yml.")
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Flags:")
		fs.SetOutput(stdout)
		fs.PrintDefaults()
	}
	dir, code, ok := parseDirArgs(fs, args, stderr)
	if !ok {
		return code
	}

	res, err := detect.DetectDir(dir)
	if errors.Is(err, detect.ErrNothingDetected) {
		fmt.Fprintln(stderr, noChecksMessage)
		return ExitNoChecks
	}
	if err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitUsage
	}
	name := compat.ConfigName(dir)
	if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
		fmt.Fprintf(stderr, "note: %s exists and takes precedence over detection\n", name)
	}

	var out []byte
	if *asJSON {
		out, err = json.MarshalIndent(res.Config, "", "  ")
		out = append(out, '\n')
	} else {
		out, err = detect.Render(res)
	}
	if err != nil {
		fmt.Fprintf(stderr, "hookci: encode detected config: %v\n", err)
		return ExitInternal
	}
	_, _ = stdout.Write(out)
	return ExitOK
}

// parseDirArgs parses flags placed before or after the optional dir
// argument (the flag package alone stops at the first positional argument)
// and checks that dir is a directory. When ok is false the caller returns
// code.
func parseDirArgs(fs *flag.FlagSet, args []string, stderr io.Writer) (dir string, code int, ok bool) {
	var positional []string
	for {
		if err := fs.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return "", ExitOK, false
			}
			return "", ExitUsage, false
		}
		args = fs.Args()
		if len(args) == 0 {
			break
		}
		positional = append(positional, args[0])
		args = args[1:]
	}
	switch len(positional) {
	case 0:
		dir = "."
	case 1:
		dir = positional[0]
	default:
		fmt.Fprintf(stderr, "hookci: %s takes at most one dir\n", fs.Name())
		return "", ExitUsage, false
	}
	if info, err := os.Stat(dir); err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return "", ExitUsage, false
	} else if !info.IsDir() {
		fmt.Fprintf(stderr, "hookci: %s is not a directory\n", dir)
		return "", ExitUsage, false
	}
	return dir, ExitOK, true
}
