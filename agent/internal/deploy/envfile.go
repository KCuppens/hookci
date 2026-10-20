package deploy

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"strings"
	"syscall"
)

// statFunc stats the env_file for the owner and mode check; tests replace it.
var statFunc = os.Stat

// LoadEnvFile reads a deployment env_file: `KEY=VALUE` lines, `#` comment
// lines, blank lines, and values optionally wrapped in double quotes. With
// requireRootOwned the file must be owned by uid 0 with a mode within 0640
// (no write or exec for group, nothing for others). The error is prefixed
// "env_file:" so the caller can put "deployments.<env>." in front of it.
func LoadEnvFile(path string, requireRootOwned bool) (map[string]string, error) {
	if requireRootOwned {
		fi, err := statFunc(path)
		if err != nil {
			return nil, fmt.Errorf("env_file: %w", err)
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		if !ok || st.Uid != 0 || fi.Mode().Perm()&^0o640 != 0 {
			return nil, fmt.Errorf("env_file: %s must be owned by root with mode 0600 or 0640", path)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("env_file: %w", err)
	}
	env := make(map[string]string)
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			return nil, fmt.Errorf("env_file: %s:%d: want KEY=VALUE", path, n)
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
			value = value[1 : len(value)-1]
		}
		env[key] = value
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("env_file: %s: %w", path, err)
	}
	return env, nil
}
