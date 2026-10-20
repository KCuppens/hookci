package compose

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// ReadMarker returns the color recorded in the marker file at path, or ""
// when the file does not exist.
func ReadMarker(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("compose: reading marker %s: %w", path, err)
	}
	return strings.TrimSpace(string(raw)), nil
}

// WriteMarker records color in the marker file at path atomically: it writes
// a temp file in the same directory, syncs it, renames it over path and syncs
// the directory.
func WriteMarker(path, color string) error {
	if err := writeFileAtomic(path, []byte(color+"\n")); err != nil {
		return fmt.Errorf("compose: writing marker: %w", err)
	}
	return nil
}

// OtherColor returns the color a deploy targets when c serves: "blue" when
// nothing or green serves, "green" when blue serves.
func OtherColor(c string) string {
	if c == "blue" {
		return "green"
	}
	return "blue"
}

// writeFileAtomic replaces path with data so readers see either the old or
// the new content, creating the parent directory when missing.
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("creating temp file in %s: %w", dir, err)
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("writing %s: %w", name, err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("syncing %s: %w", name, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("closing %s: %w", name, err)
	}
	if err := os.Chmod(name, 0o644); err != nil {
		return fmt.Errorf("chmod %s: %w", name, err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("renaming %s to %s: %w", name, path, err)
	}
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("opening %s: %w", dir, err)
	}
	defer func() { _ = d.Close() }()
	if err := d.Sync(); err != nil {
		return fmt.Errorf("syncing %s: %w", dir, err)
	}
	return nil
}
