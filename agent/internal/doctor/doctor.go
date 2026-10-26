// Package doctor diagnoses an agent host: the installed binary, the systemd
// unit, the state directory, the credential and the path to the hub. Every
// check reaches the host only through Env, so tests run them on fakes.
package doctor

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"text/tabwriter"

	"github.com/KCuppens/hookci/agent/internal/capacity"
	"github.com/KCuppens/hookci/agent/internal/clock"
	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/store"
	"github.com/KCuppens/hookci/agent/internal/systemd"
)

// Status is the outcome of a check.
type Status int

const (
	Pass Status = iota
	Warn
	Fail
	// Skip is a check that does not apply to this host, such as a caddy
	// check without a caddy route.
	Skip
)

// String is "pass", "warn", "fail" or "skip".
func (s Status) String() string {
	switch s {
	case Pass:
		return "pass"
	case Warn:
		return "warn"
	case Skip:
		return "skip"
	default:
		return "fail"
	}
}

// MarshalText encodes the status as its String, for --json.
func (s Status) MarshalText() ([]byte, error) { return []byte(s.String()), nil }

// Result is what one check found. Fix tells the user what to do about a
// Warn or Fail.
type Result struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status Status `json:"status"`
	Detail string `json:"detail"`
	Fix    string `json:"fix"`
}

// Check is one diagnosis.
type Check interface {
	ID() string
	Run(ctx context.Context, env Env) Result
}

// Execer runs host commands (hookci version, git --version).
type Execer interface {
	Run(ctx context.Context, c execx.Cmd) error
}

// Env is the host as the checks see it.
type Env struct {
	// StateRoot holds one state directory per installation id, as
	// hookci connect lays it out (/var/lib/hookci/<installation_id>).
	StateRoot string
	// HubOrigin is the hub base URL, e.g. https://app.hookci.com.
	HubOrigin string
	HTTP      *http.Client
	Clock     clock.Clock
	Exec      Execer
	// FS is the host file system rooted at /; checks open absolute paths
	// without the leading slash.
	FS      fs.FS
	Systemd systemd.ServiceManager
	// DiskFree is the bytes available to unprivileged users on the file
	// system holding path.
	DiskFree func(path string) (uint64, error)
	// Host reads the machine for the budget check, which a nil Host skips;
	// HostCPUs is its core count. BudgetCPUs and BudgetMemory are the
	// budget the agent resolves from its flags and environment (memory 0 is
	// none), BudgetErr why it could not.
	Host         capacity.Host
	HostCPUs     int
	BudgetCPUs   float64
	BudgetMemory int64
	BudgetErr    error
	// Writable is nil when the doctor's user may create files in dir.
	Writable func(dir string) error
	// RepoConfigs is what the default-branch runs of the installation in
	// stateDir saw each repository's .hookci.yml declare.
	RepoConfigs func(ctx context.Context, stateDir string) ([]store.RepoConfig, error)
}

// Run runs checks in order and returns their results.
func Run(ctx context.Context, env Env, checks []Check) []Result {
	rs := make([]Result, 0, len(checks))
	for _, c := range checks {
		r := c.Run(ctx, env)
		r.ID = c.ID()
		rs = append(rs, r)
	}
	return rs
}

// Default is every check hookci doctor runs, in display order.
func Default() []Check {
	return []Check{
		versionCheck{},
		systemdUnitCheck{},
		stateDirPermsCheck{},
		credentialCheck{},
		runUserCheck{},
		gitCheck{},
		diskSpaceCheck{},
		budgetCheck{},
		hubReachableCheck{},
		hubInfoCheck{},
		hubTLSCheck{},
		clockSkewCheck{},
		wsUpgradeCheck{},
	}
}

// Render writes rs as a table, each Warn or Fail followed by its fix, and
// reports whether any check failed.
func Render(w io.Writer, rs []Result) (failed bool) {
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "STATUS\tCHECK\tDETAIL")
	for _, r := range rs {
		fmt.Fprintf(tw, "%s\t%s\t%s\n", r.Status, r.Title, r.Detail)
		if r.Status != Pass && r.Fix != "" {
			fmt.Fprintf(tw, "\t\tfix: %s\n", r.Fix)
		}
		if r.Status == Fail {
			failed = true
		}
	}
	tw.Flush()
	return failed
}
