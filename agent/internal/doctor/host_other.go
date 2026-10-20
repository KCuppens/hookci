//go:build !unix

package doctor

import (
	"errors"
	"io/fs"
)

func ownerUID(fs.FileInfo) (uint32, bool) { return 0, false }

// HostDiskFree is unknown off unix.
func HostDiskFree(string) (uint64, error) {
	return 0, errors.New("doctor: free space is unknown on this OS")
}

// HostWritable is unknown off unix.
func HostWritable(string) error {
	return errors.New("doctor: write access is unknown on this OS")
}
