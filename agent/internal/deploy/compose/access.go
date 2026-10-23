package compose

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/KCuppens/hookci/agent/internal/store"
)

// UnitAccess lets the deploy unit, where compose runs as the deploy user,
// read the overrides the agent writes, and nothing more: each dir from the
// state dir down to an override gets the deploy user's group and mode 0710,
// the override that group and mode 0640. The agent stays the owner, so the
// unit can neither change them nor list the dirs.
type UnitAccess struct {
	Cred  func() (*syscall.Credential, error)   // the deploy user
	Chown func(name string, uid, gid int) error // nil means os.Lchown
}

// envDir is <stateDir>/deploy/<repo>/<env>: the overrides and the default
// marker of an env.
func envDir(stateDir string, run store.DeployRun) string {
	return filepath.Join(stateDir, "deploy", run.Repo, run.Env)
}

// writeOverride writes data to path, a file under stateDir, atomically.
// With a nil a the dirs and the file stay readable by the agent only.
func (a *UnitAccess) writeOverride(stateDir, path string, data []byte) error {
	dir := filepath.Dir(path)
	rel, err := filepath.Rel(stateDir, dir)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("compose: override %s is outside the state dir %s", path, stateDir)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("compose: writing override: %w", err)
	}
	var own func(name string) error
	if a != nil {
		cred, err := a.Cred()
		if err != nil {
			return fmt.Errorf("compose: writing override: %w", err)
		}
		own = a.opener(int(cred.Gid))
		if rel != "." {
			p := stateDir
			for _, part := range strings.Split(rel, string(filepath.Separator)) {
				p = filepath.Join(p, part)
				if err := own(p); err != nil {
					return fmt.Errorf("compose: writing override: %w", err)
				}
			}
		}
	}
	if err := writeFileAtomic(path, data, 0o640, own); err != nil {
		return fmt.Errorf("compose: writing override: %w", err)
	}
	return nil
}

// opener returns a func giving a dir mode 0710, or a file mode 0640, and the
// group gid.
func (a *UnitAccess) opener(gid int) func(name string) error {
	chown := a.Chown
	if chown == nil {
		chown = os.Lchown
	}
	return func(name string) error {
		info, err := os.Lstat(name)
		if err != nil {
			return err
		}
		mode := os.FileMode(0o640)
		if info.IsDir() {
			mode = 0o710
		}
		if err := chown(name, -1, gid); err != nil {
			return fmt.Errorf("hand %s to the deploy user: %w", name, err)
		}
		if err := os.Chmod(name, mode); err != nil {
			return fmt.Errorf("hand %s to the deploy user: %w", name, err)
		}
		return nil
	}
}
