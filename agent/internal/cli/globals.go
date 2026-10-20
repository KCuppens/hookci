package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/doctor"
	"github.com/KCuppens/zerocideploy/agent/internal/executor"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/netns"
	"github.com/KCuppens/zerocideploy/agent/internal/scheduler"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
	"github.com/KCuppens/zerocideploy/agent/internal/systemd"
)

// Globals are the flags given before the command.
type Globals struct {
	StateDir  string // --state-dir
	Slots     int    // --slots, >= 1
	Isolation string // --isolation: auto, systemd or none
	Verbose   bool   // -v: print step events and mirror job output
}

// parseGlobals parses the global flags at the front of args into fs and
// returns them with the remaining arguments (the command and its args).
// Defaults come from getenv. A -h or --help returns flag.ErrHelp.
func parseGlobals(fs *flag.FlagSet, args []string, getenv func(string) string) (Globals, []string, error) {
	var g Globals
	fs.StringVar(&g.StateDir, "state-dir", defaultStateDir(getenv), "state directory")
	fs.IntVar(&g.Slots, "slots", scheduler.DefaultSlots(), "parallel job slots")
	fs.StringVar(&g.Isolation, "isolation", "auto", "job isolation: auto, systemd or none")
	fs.BoolVar(&g.Verbose, "v", false, "print step events and mirror job output")
	if err := fs.Parse(args); err != nil {
		return Globals{}, nil, err
	}
	if g.StateDir == "" {
		return Globals{}, nil, errors.New("no state directory: set --state-dir or $ZEROCI_STATE_DIR")
	}
	if g.Slots < 1 {
		return Globals{}, nil, fmt.Errorf("--slots must be at least 1, got %d", g.Slots)
	}
	switch g.Isolation {
	case "auto", "systemd", "none":
	default:
		return Globals{}, nil, fmt.Errorf("--isolation must be auto, systemd or none, got %q", g.Isolation)
	}
	return g, fs.Args(), nil
}

// defaultStateDir is $ZEROCI_STATE_DIR, else $XDG_STATE_HOME/zeroci, else
// ~/.local/state/zeroci. It is empty when none of them is known.
func defaultStateDir(getenv func(string) string) string {
	if dir := getenv("ZEROCI_STATE_DIR"); dir != "" {
		return dir
	}
	if dir := getenv("XDG_STATE_HOME"); dir != "" {
		return filepath.Join(dir, "zeroci")
	}
	if home := getenv("HOME"); home != "" {
		return filepath.Join(home, ".local", "state", "zeroci")
	}
	return ""
}

// Deps are what run, status and logs need from the host. Tests replace
// them to stay hermetic.
type Deps struct {
	Globals Globals
	// StateRoot holds the state dir of each installation's agent, as
	// <StateRoot>/<installation_id>.
	StateRoot string
	// Isolation selects the job isolation by --isolation name and returns
	// its warnings.
	Isolation func(name string) (isolation.Isolation, []string, error)
	Clock     func() time.Time
	Getwd     func() (string, error)
	// Hooks are passed to the executor. A nil Cache becomes the cache under
	// the state dir and a nil Netns becomes Netns below.
	Hooks executor.Hooks
	// Host runs the host commands of crash recovery (pkill, docker).
	Host execx.Runner
	// Netns lists and removes namespaces left by a crash and, through
	// Hooks.Netns, sets up the run's network.
	Netns *netns.Manager
	// After paces logs -f polling, like time.After.
	After func(time.Duration) <-chan time.Time
	// Services enables the zeroci-agent@ unit after connect.
	Services systemd.ServiceManager
	// Doctor is the host env doctor checks for a state root and hub origin.
	Doctor func(stateRoot, hubOrigin string) doctor.Env
	// Releases is where upgrade fetches signed releases.
	Releases Releases
	// Stdin is where sink add telegram reads the bot token. When it is a
	// terminal *os.File the token is read without echo.
	Stdin io.Reader
	// Hub runs the zeroci-hub CLI for `zeroci hub`.
	Hub HubDeps
}

// DefaultDeps are the real host deps. Isolation warnings go to stderr.
func DefaultDeps(g Globals, stderr io.Writer) Deps {
	return Deps{
		Globals:   g,
		StateRoot: defaultStateRoot,
		Isolation: func(name string) (isolation.Isolation, []string, error) {
			env := isolation.HostSelectEnv()
			env.Warn = func(msg string) { fmt.Fprintf(stderr, "zeroci: warning: %s\n", msg) }
			return isolation.Select(name, env)
		},
		Clock:    time.Now,
		Getwd:    os.Getwd,
		Host:     execx.OS{},
		Netns:    &netns.Manager{},
		After:    time.After,
		Services: systemd.Systemctl{Runner: execx.OS{}},
		Doctor:   hostDoctorEnv,
		Releases: defaultReleases(),
		Stdin:    os.Stdin,
		Hub:      defaultHubDeps(),
	}
}

// hostDoctorEnv is the real host as doctor sees it.
func hostDoctorEnv(stateRoot, hubOrigin string) doctor.Env {
	return doctor.Env{
		StateRoot: stateRoot,
		HubOrigin: hubOrigin,
		HTTP:      &http.Client{},
		Clock:     clock.Real{},
		Exec:      execx.OS{},
		FS:        os.DirFS("/"),
		Systemd:   systemd.Systemctl{Runner: execx.OS{}},
		DiskFree:  doctor.HostDiskFree,
		Writable:  doctor.HostWritable,
		RepoConfigs: func(ctx context.Context, stateDir string) ([]store.RepoConfig, error) {
			return store.ReadRepoConfigs(ctx, filepath.Join(stateDir, "agent.db"))
		},
	}
}
