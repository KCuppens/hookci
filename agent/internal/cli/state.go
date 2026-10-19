package cli

import (
	"os"
	"path/filepath"
)

// defaultStateDir returns /var/lib/zeroci/local when running as root,
// or $XDG_STATE_HOME/zeroci/local, or ~/.local/state/zeroci/local.
func defaultStateDir() string {
	if env := os.Getenv("ZEROCI_STATE_DIR"); env != "" {
		return env
	}
	if os.Geteuid() == 0 {
		return "/var/lib/zeroci/local"
	}
	if xdg := os.Getenv("XDG_STATE_HOME"); xdg != "" {
		return filepath.Join(xdg, "zeroci", "local")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".", ".zeroci-state")
	}
	return filepath.Join(home, ".local", "state", "zeroci", "local")
}
