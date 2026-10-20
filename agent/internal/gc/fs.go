package gc

import (
	"io/fs"
	"os"
)

// FS is the part of the file system GC reads and removes run dirs through.
type FS interface {
	ReadDir(path string) ([]fs.DirEntry, error)
	RemoveAll(path string) error
}

// osFS is the real file system, used when Collector.FS is nil.
type osFS struct{}

func (osFS) ReadDir(path string) ([]fs.DirEntry, error) { return os.ReadDir(path) }

func (osFS) RemoveAll(path string) error { return os.RemoveAll(path) }
