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
// when the file does not exist. A marker holding anything but "blue" or
// "green" is an error: guessing a color could deploy over the live one.
func ReadMarker(path string) (string, error) {
	return readMarker(os.ReadFile, path)
}

// readMarker is ReadMarker reading through read.
func readMarker(read func(string) ([]byte, error), path string) (string, error) {
	raw, err := read(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("compose: reading marker %s: %w", path, err)
	}
	color := strings.TrimSpace(string(raw))
	if color != "blue" && color != "green" {
		return "", fmt.Errorf("compose: marker %s holds %q, want blue or green; write the live color into it or remove it if nothing serves", path, color)
	}
	return color, nil
}

// WriteMarker records color in the marker file at path atomically: it writes
// a temp file in the same directory, syncs it, renames it over path and syncs
// the directory.
func WriteMarker(path, color string) error {
	if err := writeFileAtomic(path, []byte(color+"\n"), 0o644, nil); err != nil {
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

// writeFileAtomic replaces path with data in mode perm so readers see either
// the old or the new content, creating the parent directory when missing.
// own, when not nil, runs on the new file before it replaces path.
func writeFileAtomic(path string, data []byte, perm os.FileMode, own func(name string) error) error {
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
	if err := os.Chmod(name, perm); err != nil {
		return fmt.Errorf("chmod %s: %w", name, err)
	}
	if own != nil {
		if err := own(name); err != nil {
			return err
		}
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
