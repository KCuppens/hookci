package compose

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMarker_AtomicWrite(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "deploy", "acme", "web", "production")
	path := filepath.Join(dir, "active-color")

	got, err := ReadMarker(path)
	if err != nil || got != "" {
		t.Fatalf("ReadMarker(missing) = %q, %v; want \"\", nil", got, err)
	}
	for _, color := range []string{"blue", "green"} {
		if err := WriteMarker(path, color); err != nil {
			t.Fatalf("WriteMarker(%s): %v", color, err)
		}
		if got, err := ReadMarker(path); err != nil || got != color {
			t.Fatalf("ReadMarker = %q, %v; want %q", got, err, color)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "active-color" {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("dir holds %v, want only active-color (no temp files left)", names)
	}
}

func TestMarker_WriteFailureKeepsOldColor(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	path := filepath.Join(t.TempDir(), "active-color")
	if err := WriteMarker(path, "blue"); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(path)
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	if err := WriteMarker(path, "green"); err == nil {
		t.Fatal("WriteMarker in read-only dir succeeded")
	}
	if got, _ := ReadMarker(path); got != "blue" {
		t.Fatalf("marker = %q after failed write, want blue", got)
	}
}

func TestMarker_CorruptContentIsError(t *testing.T) {
	for _, body := range []string{"", "\n", "blu\n", "GREEN\n", "green\x00"} {
		path := filepath.Join(t.TempDir(), "active-color")
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if got, err := ReadMarker(path); err == nil {
			t.Errorf("ReadMarker(%q) = %q, nil; want an error", body, got)
		}
	}
}

func TestOtherColor(t *testing.T) {
	for in, want := range map[string]string{"": "blue", "green": "blue", "blue": "green"} {
		if got := OtherColor(in); got != want {
			t.Errorf("OtherColor(%q) = %q, want %q", in, got, want)
		}
	}
}
