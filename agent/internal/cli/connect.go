package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/KCuppens/hookci/agent/internal/agentconf"
	"github.com/KCuppens/hookci/agent/internal/hubclient"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/redact"
	"github.com/KCuppens/hookci/agent/internal/systemd"
	"github.com/KCuppens/hookci/agent/internal/version"
)

const (
	defaultHubURL      = "https://ci.hookci.com"
	defaultStateRoot   = "/var/lib/hookci"
	redeemTimeout      = 30 * time.Second
	handshakeTimeout   = 15 * time.Second
	maxRedeemRespBytes = 1 << 20
	// pairTokenEnv holds the pair token when connect gets no argument.
	pairTokenEnv = "HOOKCI_PAIR_TOKEN"
	connectUsage = "usage: hookci connect [pair-token] [--hub URL] [--name NAME] [--state-dir DIR] [--force] [--no-service]"
)

// redeemRequest is the body of POST /v1/pair/redeem.
type redeemRequest struct {
	PairToken    string `json:"pair_token"`
	Name         string `json:"name"`
	Hostname     string `json:"hostname"`
	AgentVersion string `json:"agent_version"`
	OS           string `json:"os"`
	Arch         string `json:"arch"`
}

// redeemResponse is the 200 body of POST /v1/pair/redeem.
type redeemResponse struct {
	AgentID        string `json:"agent_id"`
	Credential     string `json:"credential"`
	InstallationID int64  `json:"installation_id"`
	Name           string `json:"name"`
}

// cmdConnect pairs this machine and, unless --no-service, enables and starts
// the hookci-agent@<installation_id> unit the installer wrote, restarting it
// when it already runs so it picks up the new identity. It never opens
// agent.db: the agent binds its store to the new identity when it starts.
func cmdConnect(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("connect", flag.ContinueOnError)
	fs.SetOutput(stderr)
	hub := fs.String("hub", "", "hub base URL (default $HOOKCI_HUB_URL, else "+defaultHubURL+")")
	name := fs.String("name", "", "agent name shown in Slack (default the hostname)")
	stateDir := fs.String("state-dir", "", "agent state directory (default $HOOKCI_STATE_DIR or "+d.StateRoot+"/<installation_id>)")
	force := fs.Bool("force", false, "replace an agent already configured in the state directory")
	noService := fs.Bool("no-service", false, "do not enable and start the hookci-agent@<installation_id> systemd unit")
	fs.Usage = func() {
		fmt.Fprintln(stdout, "Usage: hookci connect [pair-token] [flags]")
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Pair this machine with the hub using a pair token from Slack App Home,")
		fmt.Fprintln(stdout, "save the agent credential and check that the hub accepts it. Without a")
		fmt.Fprintln(stdout, "pair-token argument the token comes from $"+pairTokenEnv+", else one line")
		fmt.Fprintln(stdout, "on stdin, which keeps it out of the process list and shell history.")
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Flags:")
		fs.SetOutput(stdout)
		fs.PrintDefaults()
	}
	pos, err := parseInterleaved(fs, args)
	if errors.Is(err, flag.ErrHelp) {
		return ExitOK
	}
	if err != nil {
		return ExitUsage
	}
	if len(pos) > 1 || (len(pos) == 1 && pos[0] == "") {
		fmt.Fprintln(stderr, connectUsage)
		return ExitUsage
	}
	var pairToken string
	if len(pos) == 1 {
		pairToken = pos[0]
	} else if pairToken, err = readSecret(pairTokenEnv, "Pair token", d.Stdin, stderr); err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitRunFailed
	}
	if pairToken == "" {
		fmt.Fprintln(stderr, connectUsage)
		return ExitUsage
	}

	hostname, err := os.Hostname()
	if err != nil && *name == "" {
		fmt.Fprintf(stderr, "hookci: cannot read the hostname (%v): pass --name\n", err)
		return ExitUsage
	}
	if *name == "" {
		*name = hostname
	}
	hubURL, err := resolveHubURL(*hub, os.Getenv("HOOKCI_HUB_URL"))
	if err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitUsage
	}
	dir := *stateDir
	if dir == "" {
		dir = os.Getenv("HOOKCI_STATE_DIR")
	}
	// A known state dir is checked before redeeming so a refusal does not
	// burn the single-use pair token.
	if dir != "" && !*force {
		if err := checkNoAgent(dir); err != nil {
			fmt.Fprintf(stderr, "hookci: %v\n", err)
			return ExitRunFailed
		}
	}
	// The hub must speak our protocol before the single-use token is spent.
	info, err := hubclient.FetchInfo(ctx, http.DefaultClient, hubURL)
	if err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitRunFailed
	}
	if !compatible(info.ProtocolVersions, protocol.Version, protocol.Version) {
		fmt.Fprintf(stderr, "hookci: hub speaks protocol versions %d..%d, this agent speaks %d; upgrade with `hookci upgrade`\n",
			info.ProtocolVersions[0], info.ProtocolVersions[1], protocol.Version)
		return ExitRunFailed
	}

	resp, err := redeemPairToken(ctx, hubURL, redeemRequest{
		PairToken:    pairToken,
		Name:         *name,
		Hostname:     hostname,
		AgentVersion: version.Version,
		OS:           runtime.GOOS,
		Arch:         runtime.GOARCH,
	})
	if err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitRunFailed
	}

	red, _ := redact.New([]string{resp.Credential, pairToken}, nil)
	errw := red.Writer(stderr)
	defer errw.Close()

	defaultDir := filepath.Join(d.StateRoot, strconv.FormatInt(resp.InstallationID, 10))
	if dir == "" {
		dir = defaultDir
		if !*force {
			if err := checkNoAgent(dir); err != nil {
				fmt.Fprintf(errw, "hookci: %v\n", err)
				return ExitRunFailed
			}
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		fmt.Fprintf(errw, "hookci: create state directory: %v\n", err)
		return ExitRunFailed
	}
	cfg := &agentconf.AgentConfig{
		HubURL:         hubURL,
		AgentID:        resp.AgentID,
		Credential:     resp.Credential,
		Name:           resp.Name,
		InstallationID: resp.InstallationID,
		HubMode:        info.Mode,
	}
	if err := agentconf.Save(dir, cfg); err != nil {
		fmt.Fprintf(errw, "hookci: %v\n", err)
		return ExitRunFailed
	}

	log := slog.New(slog.NewTextHandler(errw, nil))
	client := hubclient.New(hubclient.Config{
		HubURL:     cfg.HubURL,
		AgentID:    cfg.AgentID,
		Credential: cfg.Credential,
		Version:    version.Version,
	}, nil, nil, log)
	hctx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()
	if _, err := client.Handshake(hctx); err != nil {
		fmt.Fprintf(errw, "hookci: agent saved to %s but the hub handshake failed: %v\n", filepath.Join(dir, agentconf.FileName), err)
		return ExitRunFailed
	}

	fmt.Fprintf(stdout, "Connected to %s as %s (agent %s)\n", cfg.HubURL, cfg.Name, cfg.AgentID)
	unit := systemd.AgentUnit(cfg.InstallationID)
	// The unit runs hookci agent --installation <id>, which reads defaultDir;
	// starting it would not run the agent saved anywhere else.
	if filepath.Clean(dir) != defaultDir {
		fmt.Fprintf(stdout, "%s runs the agent in %s, not %s; start this agent with hookci agent --state-dir %s\n", unit, defaultDir, dir, dir)
		return ExitOK
	}
	if *noService {
		if *force {
			fmt.Fprintf(stdout, "Next: sudo systemctl enable %s && sudo systemctl restart %s\n", unit, unit)
		} else {
			fmt.Fprintf(stdout, "Next: sudo systemctl enable --now %s\n", unit)
		}
		return ExitOK
	}
	exists, err := d.Services.UnitExists(ctx, unit)
	if err != nil {
		fmt.Fprintf(errw, "hookci: %v\n", err)
		return ExitRunFailed
	}
	if !exists {
		fmt.Fprintf(stdout, "No %s unit: run the installer (curl -fsSL %s/install | sh), then sudo systemctl enable --now %s\n", unit, cfg.HubURL, unit)
		return ExitOK
	}
	state, err := d.Services.ActiveState(ctx, unit)
	if err != nil {
		fmt.Fprintf(errw, "hookci: agent saved but %v\n", err)
		return ExitRunFailed
	}
	if err := d.Services.EnableNow(ctx, unit); err != nil {
		fmt.Fprintf(errw, "hookci: agent saved but %v\n", err)
		return ExitRunFailed
	}
	if !unitRunning(state) {
		fmt.Fprintf(stdout, "Started %s\n", unit)
		return ExitOK
	}
	// enable --now leaves a running unit alone, still serving the agent it
	// loaded before agent.json changed.
	if err := d.Services.TryRestart(ctx, unit); err != nil {
		fmt.Fprintf(errw, "hookci: agent saved but %v\n", err)
		return ExitRunFailed
	}
	fmt.Fprintf(stdout, "Restarted %s\n", unit)
	return ExitOK
}

// unitRunning reports whether a unit in ActiveState state runs a process.
func unitRunning(state string) bool {
	switch state {
	case "active", "activating", "reloading":
		return true
	}
	return false
}

// resolveHubURL picks the hub from --hub, else $HOOKCI_HUB_URL, else the
// shared hub. It must be https, except on loopback where a local hub runs
// over plain http.
func resolveHubURL(flagURL, envURL string) (string, error) {
	raw := flagURL
	if raw == "" {
		raw = envURL
	}
	if raw == "" {
		raw = defaultHubURL
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("hub URL %q is not an absolute URL", raw)
	}
	switch host := u.Hostname(); {
	case u.Scheme == "https":
	case u.Scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1"):
	default:
		return "", fmt.Errorf("hub URL %q must use https (plain http only for localhost)", raw)
	}
	return strings.TrimRight(raw, "/"), nil
}

// compatible reports whether the hub's [oldest, newest] protocol range
// overlaps the agent's.
func compatible(hub []int, agentMin, agentMax int) bool {
	return len(hub) == 2 && hub[0] <= agentMax && agentMin <= hub[1]
}

// checkNoAgent refuses a state dir that already holds an agent config.
func checkNoAgent(dir string) error {
	path := filepath.Join(dir, agentconf.FileName)
	cfg, err := agentconf.Load(dir)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return nil
	case err != nil:
		return fmt.Errorf("%s already exists and cannot be read (%v); pass --force to replace it", path, err)
	default:
		return fmt.Errorf("%s already holds agent %s (%s); pass --force to replace it", path, cfg.AgentID, cfg.Name)
	}
}

// redeemPairToken trades a pair token for an agent identity and credential.
func redeemPairToken(ctx context.Context, hubURL string, body redeemRequest) (*redeemResponse, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("cli: redeem: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, redeemTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, hubURL+"/v1/pair/redeem", bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("cli: redeem: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "hookci-agent/"+version.Version)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("cli: redeem: %w", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxRedeemRespBytes))
	if err != nil {
		return nil, fmt.Errorf("cli: redeem: read response: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &e) // a non-JSON error body still maps by status below
		return nil, redeemError(res.StatusCode, e.Error)
	}
	var out redeemResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("cli: redeem: decode response: %w", err)
	}
	if out.AgentID == "" || out.Credential == "" {
		return nil, errors.New("cli: redeem: hub response lacks agent_id or credential")
	}
	if out.InstallationID <= 0 {
		return nil, errors.New("cli: redeem: hub response lacks installation_id")
	}
	if out.Name == "" {
		out.Name = body.Name
	}
	return &out, nil
}

func redeemError(status int, code string) error {
	switch {
	case status == http.StatusBadRequest && code == "invalid_pair_token":
		return errors.New("pair token invalid, expired or already used: create a new one in Slack App Home")
	case status == http.StatusConflict && code == "agent_limit":
		return errors.New("this installation already has 10 agents")
	case status == http.StatusTooManyRequests:
		return errors.New("too many attempts, try again later")
	case status == http.StatusForbidden && code == "suspended":
		return errors.New("this installation is suspended")
	case code != "":
		return fmt.Errorf("cli: redeem: hub answered HTTP %d (%s)", status, code)
	default:
		return fmt.Errorf("cli: redeem: hub answered HTTP %d", status)
	}
}
