package executor

import (
	"fmt"
	"os"
	"path/filepath"
)

// RunDir is one run's directory, <StateDir>/runs/<run_id>.
type RunDir struct{ Root string }

// runSubdirs are created by NewRunDir, each with mode 0700.
var runSubdirs = []string{"src", "home", "logs", "tmp", "pg"}

// NewRunDir creates <stateDir>/runs/<runID> and its src, home, logs, tmp and
// pg subdirectories, all mode 0700.
func NewRunDir(stateDir, runID string) (RunDir, error) {
	if runID == "" || runID != filepath.Base(runID) || runID == "." || runID == ".." {
		return RunDir{}, fmt.Errorf("executor: invalid run id %q", runID)
	}
	d := RunDir{Root: filepath.Join(stateDir, "runs", runID)}
	for _, p := range append([]string{d.Root}, d.subdirs()...) {
		if err := os.MkdirAll(p, 0o700); err != nil {
			return RunDir{}, fmt.Errorf("executor: create run dir: %w", err)
		}
		// MkdirAll is subject to the umask and keeps the mode of existing dirs.
		if err := os.Chmod(p, 0o700); err != nil {
			return RunDir{}, fmt.Errorf("executor: create run dir: %w", err)
		}
	}
	return d, nil
}

func (d RunDir) subdirs() []string {
	out := make([]string, len(runSubdirs))
	for i, s := range runSubdirs {
		out[i] = filepath.Join(d.Root, s)
	}
	return out
}

// Src is the checkout and the jobs' working directory.
func (d RunDir) Src() string { return filepath.Join(d.Root, "src") }

// Home is the jobs' HOME.
func (d RunDir) Home() string { return filepath.Join(d.Root, "home") }

// Logs holds one log file per job, see logpipe.LogPath.
func (d RunDir) Logs() string { return filepath.Join(d.Root, "logs") }

// Tmp is the jobs' TMPDIR.
func (d RunDir) Tmp() string { return filepath.Join(d.Root, "tmp") }

// PG is the postgres socket directory.
func (d RunDir) PG() string { return filepath.Join(d.Root, "pg") }
