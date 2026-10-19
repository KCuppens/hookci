package cli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// errStateDirBusy reports that another zeroci run holds the state directory lock.
var errStateDirBusy = errors.New("another zeroci run is using this state directory")

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
