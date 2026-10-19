package isolation

import (
	"errors"
	"strings"
	"testing"
)

func TestSelect(t *testing.T) {
	found := func(string) (string, error) { return "/usr/bin/systemd-run", nil }
	missing := func(name string) (string, error) { return "", errors.New(name + ": not found") }

	tests := []struct {
		name     string
		backend  string
		env      SelectEnv
		want     string // backend Name(), "" when an error is expected
		warnings int
		errIs    error
		errText  string
	}{
		{name: "linux root auto", backend: "auto", env: SelectEnv{GOOS: "linux", EUID: 0, LookPath: found}, want: "systemd"},
		{name: "darwin auto", backend: "auto", env: SelectEnv{GOOS: "darwin", EUID: 501, LookPath: missing}, want: "none", warnings: 1},
		{name: "linux non-root auto", backend: "auto", env: SelectEnv{GOOS: "linux", EUID: 1000, LookPath: found}, errText: "--isolation none"},
		{name: "linux root no systemd-run auto", backend: "auto", env: SelectEnv{GOOS: "linux", EUID: 0, LookPath: missing}, errText: "--isolation none"},
		{name: "linux none hub", backend: "none", env: SelectEnv{GOOS: "linux", EUID: 0, LookPath: found, HubConnected: true}, errIs: ErrHubNone},
		{name: "darwin auto hub", backend: "auto", env: SelectEnv{GOOS: "darwin", HubConnected: true}, errIs: ErrHubNone},
		{name: "linux none", backend: "none", env: SelectEnv{GOOS: "linux", EUID: 1000}, want: "none"},
		{name: "darwin systemd", backend: "systemd", env: SelectEnv{GOOS: "darwin", EUID: 0, LookPath: found}, errIs: ErrUnsupported, errText: "darwin"},
		{name: "linux non-root systemd", backend: "systemd", env: SelectEnv{GOOS: "linux", EUID: 1000, LookPath: found}, errIs: ErrUnsupported, errText: "root"},
		{name: "linux root systemd", backend: "systemd", env: SelectEnv{GOOS: "linux", EUID: 0, LookPath: found}, want: "systemd"},
		{name: "windows auto", backend: "auto", env: SelectEnv{GOOS: "windows"}, errIs: ErrUnsupported},
		{name: "unknown", backend: "docker", env: SelectEnv{GOOS: "linux"}, errText: "unknown backend"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			iso, warnings, err := Select(tt.backend, tt.env)
			if tt.want == "" {
				if err == nil {
					t.Fatalf("Select = %s, want error", iso.Name())
				}
				if tt.errIs != nil && !errors.Is(err, tt.errIs) {
					t.Errorf("err = %v, want %v", err, tt.errIs)
				}
				if !strings.Contains(err.Error(), tt.errText) {
					t.Errorf("err = %q, want it to mention %q", err, tt.errText)
				}
				return
			}
			if err != nil {
				t.Fatalf("Select: %v", err)
			}
			if iso.Name() != tt.want {
				t.Errorf("backend = %s, want %s", iso.Name(), tt.want)
			}
			if len(warnings) != tt.warnings {
				t.Errorf("warnings = %q, want %d", warnings, tt.warnings)
			}
		})
	}
}
