package doctor

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/KCuppens/zerocideploy/agent/internal/agentconf"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/hubclient"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/systemd"
	"github.com/KCuppens/zerocideploy/agent/internal/version"
)

const (
	hubTimeout        = 5 * time.Second
	skewWarn          = 30 * time.Second
	skewFail          = 300 * time.Second
	minFreeBytes      = 2 << 30
	certExpiryWarning = 14 * 24 * time.Hour
	reinstallFix      = "rerun the installer: curl -fsSL https://ci.webuno.io/install | sh"
	connectFix        = "pair this host: sudo zeroci connect <pair-token>"
)

// minGit is the oldest git the agent's checkouts support.
var minGit = [2]int{2, 30}

// fsPath turns an absolute host path into a path in Env.FS.
func fsPath(p string) string {
	return strings.TrimPrefix(path.Clean("/"+p), "/")
}

// installation is a paired state directory under the state root.
type installation struct {
	dir  string
	conf agentconf.AgentConfig
}

// installations lists the paired state directories under the state root,
// the ones holding an agent.json, ordered by name. An agent.json that cannot
// be read or decoded is an error naming it, not an unpaired directory.
func installations(env Env) ([]installation, error) {
	root := fsPath(env.StateRoot)
	entries, err := fs.ReadDir(env.FS, root)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", env.StateRoot, pathCause(err))
	}
	var out []installation
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := path.Join(root, e.Name())
		file := "/" + path.Join(dir, agentconf.FileName)
		raw, err := fs.ReadFile(env.FS, fsPath(file))
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("%s: %w", file, pathCause(err))
		}
		var c agentconf.AgentConfig
		if err := json.Unmarshal(raw, &c); err != nil {
			return nil, fmt.Errorf("%s: %w", file, err)
		}
		out = append(out, installation{dir: "/" + dir, conf: c})
	}
	return out, nil
}

// pathCause drops the Env.FS path of a *fs.PathError, which lacks the
// leading slash of the host path the caller names instead.
func pathCause(err error) error {
	if pe, ok := errors.AsType[*fs.PathError](err); ok {
		return pe.Err
	}
	return err
}

// PairedHub is the hub URL of the first paired installation under the state
// root, or "" when none is paired.
func PairedHub(env Env) string {
	insts, err := installations(env)
	if err != nil || len(insts) == 0 {
		return ""
	}
	return insts[0].conf.HubURL
}

func pass(title, detail string) Result { return Result{Title: title, Status: Pass, Detail: detail} }

func warn(title, detail, fix string) Result {
	return Result{Title: title, Status: Warn, Detail: detail, Fix: fix}
}

func fail(title, detail, fix string) Result {
	return Result{Title: title, Status: Fail, Detail: detail, Fix: fix}
}

// output runs name args and returns its trimmed stdout.
func output(ctx context.Context, ex Execer, name string, args ...string) (string, error) {
	var out bytes.Buffer
	err := ex.Run(ctx, execx.Cmd{Name: name, Args: args, Stdout: &out})
	return strings.TrimSpace(out.String()), err
}

// versionCheck compares the zeroci on PATH with the running binary.
type versionCheck struct{}

func (versionCheck) ID() string { return "version" }

func (versionCheck) Run(ctx context.Context, env Env) Result {
	const title = "zeroci binary"
	want := version.String()
	got, err := output(ctx, env.Exec, "zeroci", "version")
	switch {
	case err != nil:
		return fail(title, fmt.Sprintf("zeroci version: %v", err), reinstallFix)
	case got != want:
		return warn(title, fmt.Sprintf("zeroci on PATH is %q, this binary is %q", got, want), reinstallFix)
	}
	return pass(title, got)
}

// systemdUnitCheck wants the zeroci-agent@ unit of every paired
// installation active.
type systemdUnitCheck struct{}

func (systemdUnitCheck) ID() string { return "systemd_unit" }

func (systemdUnitCheck) Run(ctx context.Context, env Env) Result {
	const title = "agent service"
	insts, err := installations(env)
	if errors.Is(err, fs.ErrNotExist) || (err == nil && len(insts) == 0) {
		return warn(title, "no paired installation under "+env.StateRoot, connectFix)
	}
	if err != nil {
		return fail(title, err.Error(), connectFix)
	}
	var active []string
	for _, in := range insts {
		unit := systemd.AgentUnit(in.conf.InstallationID)
		state, err := env.Systemd.ActiveState(ctx, unit)
		if err != nil {
			return fail(title, err.Error(), "check that systemd runs on this host: systemctl status "+unit)
		}
		if state != "active" {
			return fail(title, fmt.Sprintf("%s is %s", unit, orUnknown(state)),
				fmt.Sprintf("sudo systemctl enable --now %s, then read journalctl -u %s", unit, unit))
		}
		active = append(active, unit)
	}
	return pass(title, strings.Join(active, ", ")+" active")
}

func orUnknown(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}

// stateDirPermsCheck wants the state root 0700 and owned by root.
type stateDirPermsCheck struct{}

func (stateDirPermsCheck) ID() string { return "state_dir_perms" }

func (stateDirPermsCheck) Run(_ context.Context, env Env) Result {
	const title = "state directory"
	fi, err := fs.Stat(env.FS, fsPath(env.StateRoot))
	if err != nil {
		return fail(title, fmt.Sprintf("%s: %v", env.StateRoot, err), reinstallFix)
	}
	if !fi.IsDir() {
		return fail(title, env.StateRoot+" is not a directory", reinstallFix)
	}
	if perm := fi.Mode().Perm(); perm != 0o700 {
		return fail(title, fmt.Sprintf("%s has mode %04o, want 0700", env.StateRoot, perm), "sudo chmod 0700 "+env.StateRoot)
	}
	uid, ok := ownerUID(fi)
	if !ok {
		return warn(title, "cannot read the owner of "+env.StateRoot, "sudo chown root:root "+env.StateRoot)
	}
	if uid != 0 {
		return fail(title, fmt.Sprintf("%s is owned by uid %d, want root", env.StateRoot, uid), "sudo chown root:root "+env.StateRoot)
	}
	return pass(title, env.StateRoot+" is 0700 root")
}

// credentialCheck wants at least one paired installation with a credential
// that only its owner can read.
type credentialCheck struct{}

func (credentialCheck) ID() string { return "credential_present" }

func (credentialCheck) Run(_ context.Context, env Env) Result {
	const title = "agent credential"
	insts, err := installations(env)
	if err != nil {
		return fail(title, err.Error(), connectFix)
	}
	var agents []string
	for _, in := range insts {
		file := path.Join(in.dir, agentconf.FileName)
		if in.conf.Credential == "" || in.conf.AgentID == "" {
			return fail(title, file+" has no credential", connectFix)
		}
		fi, err := fs.Stat(env.FS, fsPath(file))
		if err != nil {
			return fail(title, fmt.Sprintf("%s: %v", file, err), connectFix)
		}
		if perm := fi.Mode().Perm(); perm&0o077 != 0 {
			return fail(title, fmt.Sprintf("%s has mode %04o, want 0600", file, perm), "sudo chmod 0600 "+file)
		}
		agents = append(agents, fmt.Sprintf("%s (installation %d)", in.conf.AgentID, in.conf.InstallationID))
	}
	if len(agents) == 0 {
		return fail(title, "no agent.json under "+env.StateRoot, connectFix)
	}
	return pass(title, strings.Join(agents, ", "))
}

// runUserCheck wants the unprivileged account jobs run as.
type runUserCheck struct{}

func (runUserCheck) ID() string { return "zeroci_run_user" }

func (runUserCheck) Run(_ context.Context, env Env) Result {
	const title = "job user"
	f, err := env.FS.Open("etc/passwd")
	if err != nil {
		return fail(title, fmt.Sprintf("/etc/passwd: %v", err), reinstallFix)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), isolation.DefaultUser+":") {
			return pass(title, isolation.DefaultUser+" exists")
		}
	}
	return fail(title, "no "+isolation.DefaultUser+" user", "sudo useradd --system --no-create-home --shell /usr/sbin/nologin "+isolation.DefaultUser)
}

// gitCheck wants git >= 2.30 on PATH.
type gitCheck struct{}

func (gitCheck) ID() string { return "git_present" }

func (gitCheck) Run(ctx context.Context, env Env) Result {
	const title = "git"
	const fix = "install git 2.30 or newer with the system package manager"
	out, err := output(ctx, env.Exec, "git", "--version")
	if err != nil {
		return fail(title, fmt.Sprintf("git --version: %v", err), fix)
	}
	v, ok := parseGitVersion(out)
	if !ok {
		return fail(title, fmt.Sprintf("cannot parse %q", out), fix)
	}
	if v[0] < minGit[0] || (v[0] == minGit[0] && v[1] < minGit[1]) {
		return fail(title, fmt.Sprintf("git %d.%d is older than %d.%d", v[0], v[1], minGit[0], minGit[1]), fix)
	}
	return pass(title, out)
}

// parseGitVersion reads major.minor from "git version 2.39.2[ (Apple...)]".
func parseGitVersion(s string) ([2]int, bool) {
	f := strings.Fields(strings.TrimPrefix(s, "git version "))
	if len(f) == 0 {
		return [2]int{}, false
	}
	parts := strings.SplitN(f[0], ".", 3)
	if len(parts) < 2 {
		return [2]int{}, false
	}
	major, err1 := strconv.Atoi(parts[0])
	minor, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return [2]int{}, false
	}
	return [2]int{major, minor}, true
}

// diskSpaceCheck warns under 2 GiB free on the state root.
type diskSpaceCheck struct{}

func (diskSpaceCheck) ID() string { return "disk_space" }

func (diskSpaceCheck) Run(_ context.Context, env Env) Result {
	const title = "disk space"
	free, err := env.DiskFree(env.StateRoot)
	if err != nil {
		return warn(title, fmt.Sprintf("cannot read free space of %s: %v", env.StateRoot, err), "check that "+env.StateRoot+" exists")
	}
	gib := float64(free) / (1 << 30)
	if free < minFreeBytes {
		return warn(title, fmt.Sprintf("%.1f GiB free on %s, want 2 GiB", gib, env.StateRoot), "free space on the file system holding "+env.StateRoot)
	}
	return pass(title, fmt.Sprintf("%.1f GiB free on %s", gib, env.StateRoot))
}

// getHealthz fetches <hub>/healthz within the hub timeout.
func getHealthz(ctx context.Context, env Env) (*http.Response, error) {
	ctx, cancel := context.WithTimeout(ctx, hubTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(env.HubOrigin, "/")+"/healthz", nil)
	if err != nil {
		return nil, err
	}
	resp, err := env.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	resp.Body.Close()
	return resp, nil
}

func hubFix(env Env) string {
	return "check DNS, firewall and proxy rules for outbound HTTPS to " + env.HubOrigin
}

// hubReachableCheck wants GET /healthz to answer 200 within 5 s.
type hubReachableCheck struct{}

func (hubReachableCheck) ID() string { return "hub_reachable" }

func (hubReachableCheck) Run(ctx context.Context, env Env) Result {
	const title = "hub reachable"
	resp, err := getHealthz(ctx, env)
	if err != nil {
		return fail(title, err.Error(), hubFix(env))
	}
	if resp.StatusCode != http.StatusOK {
		return fail(title, fmt.Sprintf("GET /healthz answered %d", resp.StatusCode), hubFix(env))
	}
	return pass(title, env.HubOrigin+"/healthz answered 200")
}

// hubInfoCheck names the hub from GET /v1/info: its URL, mode and version.
// A hub too old to serve /v1/info still runs agents, so failing to read it
// only warns.
type hubInfoCheck struct{}

func (hubInfoCheck) ID() string { return "hub_info" }

func (hubInfoCheck) Run(ctx context.Context, env Env) Result {
	const title = "hub"
	ctx, cancel := context.WithTimeout(ctx, hubTimeout)
	defer cancel()
	info, err := hubclient.FetchInfo(ctx, env.HTTP, env.HubOrigin)
	if errors.Is(err, hubclient.ErrNotAHub) {
		return warn(title, err.Error(), "point --hub at a zeroci hub, or pair again with zeroci connect --hub <url>")
	}
	if err != nil {
		return warn(title, err.Error(), hubFix(env))
	}
	return pass(title, fmt.Sprintf("%s (%s, version %s)", env.HubOrigin, info.Mode, info.Version))
}

// hubTLSCheck wants the hub over HTTPS with a trusted certificate that is
// not about to expire.
type hubTLSCheck struct{}

func (hubTLSCheck) ID() string { return "hub_tls" }

func (hubTLSCheck) Run(ctx context.Context, env Env) Result {
	const title = "hub TLS"
	if !strings.HasPrefix(env.HubOrigin, "https://") {
		return warn(title, env.HubOrigin+" is not HTTPS", "use an https:// hub URL")
	}
	resp, err := getHealthz(ctx, env)
	if err != nil {
		return fail(title, err.Error(), "install the system CA certificates (ca-certificates) and check that no proxy intercepts TLS")
	}
	if resp.TLS == nil || len(resp.TLS.PeerCertificates) == 0 {
		return fail(title, "no TLS certificate from "+env.HubOrigin, hubFix(env))
	}
	leaf := resp.TLS.PeerCertificates[0]
	left := leaf.NotAfter.Sub(env.Clock.Now())
	if left < certExpiryWarning {
		return warn(title, fmt.Sprintf("certificate expires %s", leaf.NotAfter.UTC().Format(time.RFC3339)), "report it to the hub operator")
	}
	return pass(title, fmt.Sprintf("certificate valid until %s", leaf.NotAfter.UTC().Format(time.DateOnly)))
}

// clockSkewCheck compares the local clock with the hub's Date header: over
// 30 s warns, over 300 s fails.
type clockSkewCheck struct{}

func (clockSkewCheck) ID() string { return "clock_skew" }

func (clockSkewCheck) Run(ctx context.Context, env Env) Result {
	const title = "clock skew"
	const fix = "enable time sync: sudo timedatectl set-ntp true"
	resp, err := getHealthz(ctx, env)
	if err != nil {
		return fail(title, "cannot reach the hub: "+err.Error(), hubFix(env))
	}
	hubTime, err := http.ParseTime(resp.Header.Get("Date"))
	if err != nil {
		return warn(title, "the hub sent no Date header", hubFix(env))
	}
	skew := env.Clock.Now().Sub(hubTime)
	if skew < 0 {
		skew = -skew
	}
	detail := fmt.Sprintf("%s from the hub", skew.Round(time.Second))
	switch {
	case skew > skewFail:
		return fail(title, detail, fix)
	case skew > skewWarn:
		return warn(title, detail, fix)
	}
	return pass(title, detail)
}

// wsUpgradeCheck opens /v1/agent/connect without a credential. The hub
// answers 401 only once the Upgrade header reached it; 426 means a proxy
// dropped it.
type wsUpgradeCheck struct{}

func (wsUpgradeCheck) ID() string { return "ws_upgrade" }

func (wsUpgradeCheck) Run(ctx context.Context, env Env) Result {
	const title = "WebSocket upgrade"
	const fix = "let the proxy pass the Upgrade and Connection headers to the hub"
	ctx, cancel := context.WithTimeout(ctx, hubTimeout)
	defer cancel()
	c, resp, err := websocket.Dial(ctx, strings.TrimRight(env.HubOrigin, "/")+"/v1/agent/connect", &websocket.DialOptions{HTTPClient: env.HTTP})
	if err == nil {
		c.CloseNow()
		return fail(title, "the hub accepted a connection without a credential", "report it to the hub operator")
	}
	if resp == nil {
		return fail(title, err.Error(), hubFix(env))
	}
	switch resp.StatusCode {
	case http.StatusUnauthorized:
		return pass(title, "upgrade reached the hub (401 without credential)")
	case http.StatusUpgradeRequired:
		return fail(title, "the hub saw no Upgrade header (426)", fix)
	}
	return fail(title, fmt.Sprintf("the hub answered %d, want 401", resp.StatusCode), fix)
}
