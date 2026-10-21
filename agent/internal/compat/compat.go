// Package compat keeps installs and repositories made under the former
// ZeroCI name working: it resolves legacy config files, environment
// variables and state directories. Nothing here moves or rewrites data.
package compat

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// Env returns $HOOKCI_<suffix>, else $ZEROCI_<suffix>, using getenv.
func Env(getenv func(string) string, suffix string) string {
	if v := getenv("HOOKCI_" + suffix); v != "" {
		return v
	}
	return getenv("ZEROCI_" + suffix)
}

// Getenv is Env over the process environment.
func Getenv(suffix string) string { return Env(os.Getenv, suffix) }

// Dir returns dir, or legacy when dir does not exist and legacy does.
func Dir(dir, legacy string) string {
	if exists(dir) || !exists(legacy) {
		return dir
	}
	return legacy
}

// StateRoot is the machine-wide state root: /var/lib/hookci, or
// /var/lib/zeroci when only that one exists.
func StateRoot() string { return Dir("/var/lib/hookci", "/var/lib/zeroci") }

// LegacyConfigFile and ConfigFile name a repository's checks file.
const (
	ConfigFile       = ".hookci.yml"
	LegacyConfigFile = ".zeroci.yml"
)

// LegacyWarning is printed when a repository only has the legacy config.
const LegacyWarning = LegacyConfigFile + " is deprecated, rename it to " + ConfigFile

// ConfigName returns which of the two config names to use in dir: the
// legacy one only when ConfigFile is absent and LegacyConfigFile exists.
func ConfigName(dir string) string {
	if !exists(filepath.Join(dir, ConfigFile)) && exists(filepath.Join(dir, LegacyConfigFile)) {
		return LegacyConfigFile
	}
	return ConfigFile
}

// ReadConfig reads dir's config file with the legacy fallback. It returns
// the name actually read. A missing file returns fs.ErrNotExist.
func ReadConfig(dir string) (data []byte, name string, err error) {
	name = ConfigName(dir)
	data, err = os.ReadFile(filepath.Join(dir, name))
	return data, name, err
}

// ReadConfigWarn is ReadConfig that prints LegacyWarning to w when the
// legacy file was used.
func ReadConfigWarn(dir string, w io.Writer) ([]byte, string, error) {
	data, name, err := ReadConfig(dir)
	if err == nil && name == LegacyConfigFile && w != nil {
		fmt.Fprintln(w, LegacyWarning)
	}
	return data, name, err
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil || !errors.Is(err, fs.ErrNotExist)
}
