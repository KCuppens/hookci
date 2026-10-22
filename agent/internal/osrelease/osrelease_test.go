package osrelease

import (
	"errors"
	"strings"
	"testing"
	"unicode/utf8"
)

// fakeSource answers from maps, so no test touches the real machine.
type fakeSource struct {
	goos  string
	files map[string]string
	cmds  map[string]string
	ran   []string
}

func (f *fakeSource) GOOS() string { return f.goos }

func (f *fakeSource) ReadFile(name string) ([]byte, error) {
	if s, ok := f.files[name]; ok {
		return []byte(s), nil
	}
	return nil, errors.New("no such file")
}

func (f *fakeSource) Output(name string, args ...string) ([]byte, error) {
	key := strings.Join(append([]string{name}, args...), " ")
	f.ran = append(f.ran, key)
	if s, ok := f.cmds[key]; ok {
		return []byte(s), nil
	}
	return nil, errors.New("no such command")
}

func TestDetectLinux(t *testing.T) {
	cases := []struct {
		name, file, want string
	}{
		{"ubuntu lts patch", "NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 22.04.4 LTS\"\nVERSION_ID=\"22.04\"\n", "Ubuntu 22.04"},
		{"ubuntu plain", "PRETTY_NAME=\"Ubuntu 24.10\"\n", "Ubuntu 24.10"},
		{"debian keeps codename", "PRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\n", "Debian GNU/Linux 12 (bookworm)"},
		{"rolling", "PRETTY_NAME='Arch Linux'\nID=arch\n", "Arch Linux"},
		{"no pretty name", "NAME=\"Alpine Linux\"\nID=alpine\nVERSION_ID=3.19.1\n", "Alpine Linux 3.19"},
		{"id fallback", "ID=fedora\nVERSION_ID=40\n", "fedora 40"},
		{"comments and blanks", "# note\n\nPRETTY_NAME=\"Rocky Linux 9.3 (Blue Onyx)\"\n", "Rocky Linux 9.3 (Blue Onyx)"},
		{"empty", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Detect(&fakeSource{goos: "linux", files: map[string]string{"/etc/os-release": c.file}})
			if got != c.want {
				t.Errorf("Detect = %q, want %q", got, c.want)
			}
		})
	}
}

func TestDetectLinuxMissingFile(t *testing.T) {
	if got := Detect(&fakeSource{goos: "linux"}); got != "" {
		t.Errorf("Detect without os-release = %q, want empty", got)
	}
}

func TestDetectDarwin(t *testing.T) {
	src := &fakeSource{goos: "darwin", cmds: map[string]string{
		"sw_vers -productName":    "macOS\n",
		"sw_vers -productVersion": "14.5\n",
	}}
	if got := Detect(src); got != "macOS 14.5" {
		t.Errorf("Detect = %q, want macOS 14.5", got)
	}
	src.cmds["sw_vers -productVersion"] = "13.6.7\n"
	if got := Detect(src); got != "macOS 13.6" {
		t.Errorf("Detect with patch = %q, want macOS 13.6", got)
	}
	if got := Detect(&fakeSource{goos: "darwin"}); got != "" {
		t.Errorf("Detect without sw_vers = %q, want empty", got)
	}
}

func TestDetectWindows(t *testing.T) {
	cases := []struct{ ver, want string }{
		{"\r\nMicrosoft Windows [Version 10.0.22631.3447]\r\n", "Windows 11"},
		{"Microsoft Windows [Version 10.0.19045.4291]", "Windows 10"},
		{"Microsoft Windows [Versie 10.0.22000.1]", "Windows 11"},
		{"Microsoft Windows [Version 6.3.9600]", "Windows 6.3.9600"},
		{"unexpected output", ""},
	}
	for _, c := range cases {
		src := &fakeSource{goos: "windows", cmds: map[string]string{"cmd /c ver": c.ver}}
		if got := Detect(src); got != c.want {
			t.Errorf("Detect(%q) = %q, want %q", c.ver, got, c.want)
		}
	}
	if got := Detect(&fakeSource{goos: "windows"}); got != "" {
		t.Errorf("Detect without ver = %q, want empty", got)
	}
}

func TestDetectUnknownSystemRunsNothing(t *testing.T) {
	src := &fakeSource{goos: "plan9"}
	if got := Detect(src); got != "" || len(src.ran) != 0 {
		t.Errorf("Detect = %q, ran %v; want empty and nothing run", got, src.ran)
	}
}

func TestSanitize(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Ubuntu 22.04", "Ubuntu 22.04"},
		{"  Ubuntu \t 22.04\n", "Ubuntu 22.04"},
		{"Ubuntu\x00 22\x1b[31m.04\x7f", "Ubuntu 22[31m.04"},
		{"bad\xffbytes", "badbytes"},
		{"\u200bzero", "zero"},
		{"", ""},
	}
	for _, c := range cases {
		if got := Sanitize(c.in); got != c.want {
			t.Errorf("Sanitize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSanitizeCapsLength(t *testing.T) {
	got := Sanitize(strings.Repeat("a", 200))
	if len(got) != MaxLen {
		t.Errorf("length = %d, want %d", len(got), MaxLen)
	}
	multi := Sanitize(strings.Repeat("é", 200))
	if utf8.RuneCountInString(multi) != MaxLen || !utf8.ValidString(multi) {
		t.Errorf("multibyte result has %d runes, valid=%v", utf8.RuneCountInString(multi), utf8.ValidString(multi))
	}
	spaced := Sanitize(strings.Repeat("a", 63) + " bbb")
	if spaced != strings.Repeat("a", 63) {
		t.Errorf("a space at the cap left %q", spaced)
	}
}

func TestDetectSanitizesFileContent(t *testing.T) {
	file := "PRETTY_NAME=\"Evil\x1b[2J " + strings.Repeat("x", 100) + "\"\n"
	got := Detect(&fakeSource{goos: "linux", files: map[string]string{"/etc/os-release": file}})
	if utf8.RuneCountInString(got) > MaxLen || strings.ContainsRune(got, 0x1b) {
		t.Errorf("Detect = %q; want printable and at most %d characters", got, MaxLen)
	}
}
