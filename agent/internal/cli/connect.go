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
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/agentconf"
	"github.com/KCuppens/zerocideploy/agent/internal/hubclient"
	"github.com/KCuppens/zerocideploy/agent/internal/redact"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
	"github.com/KCuppens/zerocideploy/agent/internal/version"
)

const (
	defaultHubURL      = "https://ci.webuno.io"
	defaultStateRoot   = "/var/lib/zeroci"
	redeemTimeout      = 30 * time.Second
	handshakeTimeout   = 15 * time.Second
	maxRedeemRespBytes = 1 << 20
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

func runConnect(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("connect", flag.ContinueOnError)
	fs.SetOutput(stderr)
	hub := fs.String("hub", defaultHubURL, "hub base URL")
	name := fs.String("name", "", "agent name shown in Slack (default the hostname)")
	stateDir := fs.String("state-dir", "", "agent state directory (default $ZEROCI_STATE_DIR or "+defaultStateRoot+"/<installation_id>)")
	force := fs.Bool("force", false, "replace an agent already configured in the state directory")
	fs.Usage = func() {
		fmt.Fprintln(stdout, "Usage: zeroci connect <pair-token> [flags]")
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Pair this machine with the hub using a pair token from Slack App Home,")
		fmt.Fprintln(stdout, "save the agent credential and check that the hub accepts it.")
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
	if len(pos) != 1 || pos[0] == "" {
		fmt.Fprintln(stderr, "usage: zeroci connect <pair-token> [--hub URL] [--name NAME] [--state-dir DIR] [--force]")
		return ExitUsage
	}
	pairToken := pos[0]

	hostname, err := os.Hostname()
	if err != nil && *name == "" {
		fmt.Fprintf(stderr, "zeroci: cannot read the hostname (%v): pass --name\n", err)
		return ExitUsage
	}
	if *name == "" {
		*name = hostname
	}
	hubURL := strings.TrimRight(*hub, "/")
	dir := *stateDir
	if dir == "" {
		dir = os.Getenv("ZEROCI_STATE_DIR")
	}
	// A known state dir is checked before redeeming so a refusal does not
	// burn the single-use pair token.
	if dir != "" && !*force {
		if err := checkNoAgent(dir); err != nil {
			fmt.Fprintf(stderr, "zeroci: %v\n", err)
			return ExitRunFailed
		}
	}

	resp, err := redeemPairToken(ctx, hubURL, redeemRequest{
		PairToken:    pairToken,
		Name:         *name,
		Hostname:     hostname,
		AgentVersion: version.String(),
		OS:           runtime.GOOS,
		Arch:         runtime.GOARCH,
	})
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitRunFailed
	}

	red, _ := redact.New([]string{resp.Credential, pairToken}, nil)
	errw := red.Writer(stderr)
	defer errw.Close()

	if dir == "" {
		dir = filepath.Join(defaultStateRoot, strconv.FormatInt(resp.InstallationID, 10))
		if !*force {
			if err := checkNoAgent(dir); err != nil {
				fmt.Fprintf(errw, "zeroci: %v\n", err)
				return ExitRunFailed
			}
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		fmt.Fprintf(errw, "zeroci: create state directory: %v\n", err)
		return ExitRunFailed
	}
	cfg := &agentconf.AgentConfig{
		HubURL:         hubURL,
		AgentID:        resp.AgentID,
		Credential:     resp.Credential,
		Name:           resp.Name,
		InstallationID: resp.InstallationID,
	}
	if err := agentconf.Save(dir, cfg); err != nil {
		fmt.Fprintf(errw, "zeroci: %v\n", err)
		return ExitRunFailed
	}

	st, err := store.Open(filepath.Join(dir, "agent.db"))
	if err != nil {
		fmt.Fprintf(errw, "zeroci: open store: %v\n", err)
		return ExitRunFailed
	}
	defer st.Close()
	log := slog.New(slog.NewTextHandler(errw, nil))
	client := hubclient.New(hubclient.Config{
		HubURL:     cfg.HubURL,
		AgentID:    cfg.AgentID,
		Credential: cfg.Credential,
		Version:    version.String(),
	}, st, nil, log)
	hctx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()
	if _, err := client.Handshake(hctx); err != nil {
		fmt.Fprintf(errw, "zeroci: agent saved to %s but the hub handshake failed: %v\n", filepath.Join(dir, agentconf.FileName), err)
		return ExitRunFailed
	}

	fmt.Fprintf(stdout, "Connected to %s as %s (agent %s)\n", cfg.HubURL, cfg.Name, cfg.AgentID)
	fmt.Fprintln(stdout, "Next: sudo systemctl enable --now zeroci")
	return ExitOK
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
	req.Header.Set("User-Agent", "zeroci-agent/"+version.String())
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
