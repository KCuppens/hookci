package cli

import (
	"bytes"
	"strings"
	"testing"
)

func TestMainVersion(t *testing.T) {
	var stdout, stderr bytes.Buffer

	code := Main([]string{"version"}, &stdout, &stderr)

	if code != ExitOK {
		t.Fatalf("exit code = %d, want %d", code, ExitOK)
	}
	if !strings.Contains(stdout.String(), "zeroci dev") {
		t.Fatalf("stdout = %q, want to contain %q", stdout.String(), "zeroci dev")
	}
}

func TestMainUnknownCommand(t *testing.T) {
	var stdout, stderr bytes.Buffer

	code := Main([]string{"nope"}, &stdout, &stderr)

	if code != ExitUsage {
		t.Fatalf("exit code = %d, want %d", code, ExitUsage)
	}
	if !strings.Contains(stderr.String(), "unknown command") {
		t.Fatalf("stderr = %q, want to contain %q", stderr.String(), "unknown command")
	}
}

func TestMainHelp(t *testing.T) {
	cases := []struct {
		name string
		args []string
	}{
		{"no args", nil},
		{"help", []string{"help"}},
		{"-h", []string{"-h"}},
		{"--help", []string{"--help"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer

			code := Main(tc.args, &stdout, &stderr)

			if code != ExitOK {
				t.Fatalf("exit code = %d, want %d", code, ExitOK)
			}
			if !strings.Contains(stdout.String(), "version") {
				t.Fatalf("stdout = %q, want to contain %q", stdout.String(), "version")
			}
		})
	}
}
