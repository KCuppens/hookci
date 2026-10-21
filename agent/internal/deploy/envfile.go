package deploy

import (
	"errors"
	"fmt"
	"os"
	"syscall"

	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/redact"
)

// fstatFunc stats the opened env_file for the owner and mode check; tests
// replace it.
var fstatFunc = (*os.File).Stat

// LoadEnvFile reads a deployment env_file with redact.ParseEnv and rejects
// any line that is not KEY=VALUE. It opens path without following a symlink
// and checks and reads that same open file. With requireRootOwned the file
// must be owned by uid 0 with no permission for group or others. The error
// is prefixed "env_file:" so the caller can put "deployments.<env>." in
// front of it.
func LoadEnvFile(path string, requireRootOwned bool) (map[string]string, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if errors.Is(err, syscall.ELOOP) {
		return nil, fmt.Errorf("env_file: %s is a symlink; name the file itself", path)
	}
	if err != nil {
		return nil, fmt.Errorf("env_file: %w", err)
	}
	defer f.Close()
	if requireRootOwned {
		fi, err := fstatFunc(f)
		if err != nil {
			return nil, fmt.Errorf("env_file: %w", err)
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		if !ok || st.Uid != 0 || !config.EnvFilePermOK(fi.Mode().Perm()) {
			return nil, fmt.Errorf("env_file: %s must be owned by root with mode 0600", path)
		}
	}
	entries, bad, err := redact.ParseEnv(f)
	if err != nil {
		return nil, fmt.Errorf("env_file: %s: %w", path, err)
	}
	if len(bad) > 0 {
		return nil, fmt.Errorf("env_file: %s:%d: want KEY=VALUE", path, bad[0])
	}
	env := make(map[string]string, len(entries))
	for _, e := range entries {
		env[e.Key] = e.Value
	}
	return env, nil
}
