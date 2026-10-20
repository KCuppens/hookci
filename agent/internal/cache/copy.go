package cache

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"syscall"
	"time"
)

// copyTree copies src to dst, which must not exist. src may be a directory,
// a regular file or a symlink. It keeps permission bits and mtimes, keeps
// owners when running as root, copies symlinks as links with their text
// verbatim and never follows them, and skips sockets, devices and fifos.
// Every node under dst is created fresh (Mkdir, O_EXCL, Symlink), so nothing
// is ever written through an existing link.
func copyTree(src, dst string) error {
	type dirAttrs struct {
		path string
		info fs.FileInfo
	}
	var dirs []dirAttrs
	err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case d.IsDir():
			// Owner rwx until the walk ends so read-only dirs can be filled.
			if err := os.Mkdir(target, 0o700); err != nil {
				return err
			}
			dirs = append(dirs, dirAttrs{target, info})
		case d.Type().IsRegular():
			return copyFile(path, target, info)
		case d.Type()&fs.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			if err := os.Symlink(link, target); err != nil {
				return err
			}
			return chownLike(target, info, lchownAsRoot)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("cache: copy %s: %w", src, err)
	}
	// Deepest first, so setting a child's mtime does not touch its parent's.
	for _, d := range slices.Backward(dirs) {
		if err := setAttrs(d.path, d.info); err != nil {
			return fmt.Errorf("cache: copy %s: %w", src, err)
		}
	}
	return nil
}

func copyFile(src, dst string, info fs.FileInfo) (err error) {
	in, err := os.OpenFile(src, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		return errors.Join(err, out.Close())
	}
	if err := out.Close(); err != nil {
		return err
	}
	return setAttrs(dst, info)
}

// setAttrs gives path the owner, permission bits and mtime of info. chown
// runs first because it clears set-id bits.
func setAttrs(path string, info fs.FileInfo) error {
	if err := chownLike(path, info, lchownAsRoot); err != nil {
		return err
	}
	if err := os.Chmod(path, info.Mode().Perm()); err != nil {
		return err
	}
	return os.Chtimes(path, time.Time{}, info.ModTime())
}

// chownLike gives path the owner of info through chown.
func chownLike(path string, info fs.FileInfo, chown func(path string, uid, gid int) error) error {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	return chown(path, int(st.Uid), int(st.Gid))
}

// lchownAsRoot changes path's owner when running as root. Other users cannot
// chown, and their copies are theirs anyway.
func lchownAsRoot(path string, uid, gid int) error {
	if os.Geteuid() != 0 {
		return nil
	}
	return os.Lchown(path, uid, gid)
}
