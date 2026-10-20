package executor

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// RunDir is one run's directory, <StateDir>/runs/<run_id>.
type RunDir struct{ Root string }

// runSubdirs are created by NewRunDir, each with mode 0700.
var runSubdirs = []string{"src", "home", "logs", "tmp", "pg"}

// jobSubdirs are the subdirs a job writes: its checkout, HOME and TMPDIR.
var jobSubdirs = []string{"src", "home", "tmp"}

// JobUser is the account a run's jobs run as.
type JobUser struct {
	Cred  *syscall.Credential                   // uid and gid; nil: the agent's own user
	Chown func(path string, uid, gid int) error // nil: os.Lchown
}

// NewRunDir creates <stateDir>/runs/<runID> and its src, home, logs, tmp and
// pg subdirectories, all mode 0700 and owned by the agent. With job.Cred set,
// src, home and tmp go to the job user, and stateDir, <stateDir>/runs and the
// run dir become 0711 so the job user can reach them without listing them;
// logs and pg stay the agent's. Every ancestor of stateDir must already be
// searchable by the job user.
func NewRunDir(stateDir, runID string, job JobUser) (RunDir, error) {
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
	if job.Cred == nil {
		return d, nil
	}
	if err := job.handOver(stateDir, d); err != nil {
		return RunDir{}, fmt.Errorf("executor: hand run dir to job user: %w", err)
	}
	return d, nil
}

func (j JobUser) handOver(stateDir string, d RunDir) error {
	if err := OpenTo(stateDir, j.Cred, filepath.Join(stateDir, "runs"), d.Root); err != nil {
		return err
	}
	chown := j.Chown
	if chown == nil {
		chown = os.Lchown
	}
	for _, s := range jobSubdirs {
		if err := chown(filepath.Join(d.Root, s), int(j.Cred.Uid), int(j.Cred.Gid)); err != nil {
			return err
		}
	}
	return nil
}

// OpenTo lets cred reach dirs under stateDir without listing them: it checks
// that every ancestor of stateDir is searchable by cred, then makes stateDir
// and dirs mode 0711.
func OpenTo(stateDir string, cred *syscall.Credential, dirs ...string) error {
	abs, err := filepath.Abs(stateDir)
	if err != nil {
		return err
	}
	for dir := filepath.Dir(abs); ; dir = filepath.Dir(dir) {
		info, err := os.Stat(dir)
		if err != nil {
			return err
		}
		if !searchable(info, cred) {
			return fmt.Errorf("%s (mode %o) is not searchable by uid %d; use a state dir every user can reach, such as /var/lib/zeroci", dir, info.Mode().Perm(), cred.Uid)
		}
		if dir == filepath.Dir(dir) {
			break
		}
	}
	for _, p := range append([]string{stateDir}, dirs...) {
		if err := os.Chmod(p, 0o711); err != nil {
			return err
		}
	}
	return nil
}

// searchable reports whether cred may traverse a dir with info by its owner,
// group and other bits. Supplementary groups and ACLs are not consulted.
func searchable(info fs.FileInfo, cred *syscall.Credential) bool {
	perm := info.Mode().Perm()
	st, ok := info.Sys().(*syscall.Stat_t)
	switch {
	case !ok:
		return true
	case st.Uid == cred.Uid:
		return perm&0o100 != 0
	case st.Gid == cred.Gid:
		return perm&0o010 != 0
	}
	return perm&0o001 != 0
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
