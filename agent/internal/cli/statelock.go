package cli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// errStateDirBusy reports that another hookci run holds the state directory lock.
var errStateDirBusy = errors.New("another hookci run is using this state directory")

// lockStateDir takes an exclusive, non-blocking lock on stateDir for the life of a run.
// Crash recovery treats every active run in the store as dead, so two runs must never
// share a state directory. The kernel drops the lock when the process exits, so a crash
// never leaves it stale.
func lockStateDir(stateDir string) (unlock func(), err error) {
	f, err := os.OpenFile(filepath.Join(stateDir, "run.lock"), os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open state lock: %w", err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, errStateDirBusy
		}
		return nil, fmt.Errorf("lock state dir: %w", err)
	}
	return func() { _ = f.Close() }, nil
}

// stateDirLocked reports whether a hookci run holds the lock on stateDir.
// The probe holds a shared lock only for the instant of the check.
func stateDirLocked(stateDir string) (bool, error) {
	f, err := os.Open(filepath.Join(stateDir, "run.lock"))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("open state lock: %w", err)
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_SH|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return true, nil
		}
		return false, fmt.Errorf("probe state lock: %w", err)
	}
	return false, nil
}
