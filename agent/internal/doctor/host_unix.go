//go:build unix

package doctor

import (
	"io/fs"
	"syscall"
)

// ownerUID is the owner of fi when the file system reports it.
func ownerUID(fi fs.FileInfo) (uint32, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return st.Uid, true
}

// HostDiskFree is the space available to unprivileged users on the file
// system holding path.
func HostDiskFree(path string) (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	return st.Bavail * uint64(st.Bsize), nil
}

// HostWritable is nil when the real user may create files in dir.
func HostWritable(dir string) error {
	const wOK = 0x2
	return syscall.Access(dir, wOK)
}
