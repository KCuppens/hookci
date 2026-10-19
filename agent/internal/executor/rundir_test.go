package executor

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRunDirLayout(t *testing.T) {
	state := t.TempDir()
	d, err := NewRunDir(state, "01run")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(state, "runs", "01run"); d.Root != want {
		t.Fatalf("Root = %s, want %s", d.Root, want)
	}
	for name, got := range map[string]string{"src": d.Src(), "home": d.Home(), "logs": d.Logs(), "tmp": d.Tmp(), "pg": d.PG()} {
		if want := filepath.Join(d.Root, name); got != want {
			t.Errorf("%s accessor = %s, want %s", name, got, want)
		}
		fi, err := os.Stat(got)
		if err != nil {
			t.Fatal(err)
		}
		if !fi.IsDir() || fi.Mode().Perm() != 0o700 {
			t.Errorf("%s: mode %v, want dir 0700", name, fi.Mode())
		}
	}

	for _, bad := range []string{"", ".", "..", "a/b"} {
		if _, err := NewRunDir(state, bad); err == nil {
			t.Errorf("NewRunDir(%q) succeeded", bad)
		}
	}
}
