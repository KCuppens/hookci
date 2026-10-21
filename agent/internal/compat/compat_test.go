package compat

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestEnvPrecedence(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"neither", nil, ""},
		{"legacy only", map[string]string{"ZEROCI_STATE_DIR": "/old"}, "/old"},
		{"new only", map[string]string{"HOOKCI_STATE_DIR": "/new"}, "/new"},
		{"both prefers new", map[string]string{"HOOKCI_STATE_DIR": "/new", "ZEROCI_STATE_DIR": "/old"}, "/new"},
		{"empty new falls back", map[string]string{"HOOKCI_STATE_DIR": "", "ZEROCI_STATE_DIR": "/old"}, "/old"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Env(func(k string) string { return tc.env[k] }, "STATE_DIR"); got != tc.want {
				t.Errorf("Env = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestGetenvReadsProcessEnv(t *testing.T) {
	t.Setenv("HOOKCI_CACHE_MODE", "")
	t.Setenv("ZEROCI_CACHE_MODE", "copy")
	if got := Getenv("CACHE_MODE"); got != "copy" {
		t.Errorf("Getenv = %q, want copy", got)
	}
	t.Setenv("HOOKCI_CACHE_MODE", "overlay")
	if got := Getenv("CACHE_MODE"); got != "overlay" {
		t.Errorf("Getenv = %q, want overlay", got)
	}
}

func TestDir(t *testing.T) {
	root := t.TempDir()
	newDir, oldDir := filepath.Join(root, "hookci"), filepath.Join(root, "zeroci")

	if got := Dir(newDir, oldDir); got != newDir {
		t.Errorf("neither exists: %q, want the new dir", got)
	}
	if err := os.Mkdir(oldDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if got := Dir(newDir, oldDir); got != oldDir {
		t.Errorf("only legacy exists: %q, want the legacy dir", got)
	}
	if err := os.Mkdir(newDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if got := Dir(newDir, oldDir); got != newDir {
		t.Errorf("both exist: %q, want the new dir", got)
	}
}

func write(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestReadConfig(t *testing.T) {
	dir := t.TempDir()
	if _, _, err := ReadConfig(dir); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("empty dir: err = %v, want not exist", err)
	}

	write(t, dir, LegacyConfigFile)
	var warn bytes.Buffer
	data, name, err := ReadConfigWarn(dir, &warn)
	if err != nil || name != LegacyConfigFile || string(data) != LegacyConfigFile {
		t.Fatalf("legacy only: %q, %q, %v", data, name, err)
	}
	if want := ".zeroci.yml is deprecated, rename it to .hookci.yml\n"; warn.String() != want {
		t.Errorf("warning = %q, want %q", warn.String(), want)
	}

	write(t, dir, ConfigFile)
	warn.Reset()
	data, name, err = ReadConfigWarn(dir, &warn)
	if err != nil || name != ConfigFile || string(data) != ConfigFile {
		t.Fatalf("both: %q, %q, %v", data, name, err)
	}
	if warn.Len() != 0 {
		t.Errorf("both present printed %q, want no warning", warn.String())
	}
}
