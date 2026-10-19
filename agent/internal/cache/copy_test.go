package cache

import (
	"errors"
	"io/fs"
	"maps"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// treeState describes every node under root: type, permission bits, mtime
// for files and dirs, content for files and link text for symlinks.
func treeState(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			out[rel] = "link " + link
		case d.IsDir():
			out[rel] = "dir " + info.Mode().Perm().String() + " " + info.ModTime().UTC().String()
		case d.Type().IsRegular():
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			out[rel] = "file " + info.Mode().Perm().String() + " " + info.ModTime().UTC().String() + " " + string(data)
		default:
			out[rel] = "special " + info.Mode().String()
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestCopyTreeKeepsModesAndMtimes(t *testing.T) {
	src := filepath.Join(t.TempDir(), "src")
	writeFile(t, filepath.Join(src, "a.txt"), "a", 0o640)
	writeFile(t, filepath.Join(src, "bin", "tool"), "#!/bin/sh\n", 0o755)
	writeFile(t, filepath.Join(src, "ro", "x"), "x", 0o444)
	old := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	for _, p := range []string{"a.txt", "bin/tool", "ro/x", "bin", "ro", "."} {
		if err := os.Chtimes(filepath.Join(src, p), old, old); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(filepath.Join(src, "ro"), 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(src, "ro"), 0o755) })
	dst := filepath.Join(t.TempDir(), "dst")
	if err := copyTree(src, dst); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(dst, "ro"), 0o755) })
	if got, want := treeState(t, dst), treeState(t, src); !maps.Equal(got, want) {
		t.Errorf("copy differs:\n got %v\nwant %v", got, want)
	}
	if err := copyTree(src, dst); err == nil {
		t.Error("copy onto an existing dst succeeded")
	}
}

func TestCopyTreeDoesNotFollowSymlinks(t *testing.T) {
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "secret"), "host secret", 0o600)
	src := filepath.Join(t.TempDir(), "src")
	writeFile(t, filepath.Join(src, "pkg", "index.js"), "js", 0o644)
	links := map[string]string{
		"abs":         outside,
		"pkg/rel":     "../abs/secret",
		"dangling":    "does/not/exist",
		"pkg/up/self": "..",
	}
	if err := os.MkdirAll(filepath.Join(src, "pkg", "up"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, target := range links {
		if err := os.Symlink(target, filepath.Join(src, name)); err != nil {
			t.Fatal(err)
		}
	}
	dst := filepath.Join(t.TempDir(), "dst")
	if err := copyTree(src, dst); err != nil {
		t.Fatal(err)
	}
	for name, target := range links {
		info, err := os.Lstat(filepath.Join(dst, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode()&fs.ModeSymlink == 0 {
			t.Errorf("%s is %v, want a symlink", name, info.Mode())
			continue
		}
		if got, _ := os.Readlink(filepath.Join(dst, name)); got != target {
			t.Errorf("%s -> %q, want %q", name, got, target)
		}
	}

	// A symlink root is copied as a link, not as the tree it points at.
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	dst2 := filepath.Join(t.TempDir(), "dst2")
	if err := copyTree(link, dst2); err != nil {
		t.Fatal(err)
	}
	if got, err := os.Readlink(dst2); err != nil || got != outside {
		t.Errorf("root link copy = %q, %v", got, err)
	}
}

func TestCopyTreeSkipsSpecialFiles(t *testing.T) {
	src, err := os.MkdirTemp("", "zc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(src) })
	writeFile(t, filepath.Join(src, "f"), "f", 0o644)
	if err := syscall.Mkfifo(filepath.Join(src, "fifo"), 0o644); err != nil {
		t.Fatal(err)
	}
	l, err := net.Listen("unix", filepath.Join(src, "sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	dst := filepath.Join(t.TempDir(), "dst")
	if err := copyTree(src, dst); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"fifo", "sock"} {
		if _, err := os.Lstat(filepath.Join(dst, name)); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("%s copied: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dst, "f")); err != nil {
		t.Error(err)
	}
}
