package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/agentconf"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/strategies"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/proxy/caddy"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
	"github.com/KCuppens/zerocideploy/agent/internal/version"
)

const (
	// renderTimeout bounds the badge request to the hub.
	renderTimeout = 10 * time.Second
	// maxRenderRespBytes bounds the hub's badge answer.
	maxRenderRespBytes = 1 << 20
)

var (
	commitRE = regexp.MustCompile(`^[0-9a-f]{40}$`)
	repoRE   = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
)

// cmdDeploy prints what a deploy of an environment would do: the steps,
// colors and port, image, compose override and route diff, then the Slack
// badge the hub would post. It runs no command and writes nothing.
func cmdDeploy(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("deploy", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dryRun := fs.Bool("dry-run", false, "print the plan without deploying")
	repoFlag := fs.String("repo", "", "repository as owner/name (default: the github.com origin remote)")
	shaFlag := fs.String("sha", "", "commit to preview (default: the last deployed commit, else HEAD)")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: zeroci [global flags] deploy <env> --dry-run [--repo owner/name] [--sha SHA]")
		fmt.Fprintln(stderr)
		fmt.Fprintln(stderr, "Print what a deploy of env from the current checkout would do. Nothing runs and nothing changes.")
		fs.PrintDefaults()
	}
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		return ExitUsage
	}
	if len(pos) != 1 {
		fs.Usage()
		return ExitUsage
	}
	if !*dryRun {
		fmt.Fprintln(stderr, "deploy: only --dry-run is supported; deploys start from a push or zeroci retry")
		return ExitUsage
	}
	env := pos[0]
	if *shaFlag != "" && !commitRE.MatchString(*shaFlag) {
		fmt.Fprintf(stderr, "zeroci: deploy: --sha %q must be a full 40-character lowercase commit\n", *shaFlag)
		return ExitUsage
	}

	wd, err := d.Getwd()
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitInternal
	}
	top, gitDir, err := gitCheckout(wd)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: deploy: %v\n", err)
		return ExitUsage
	}
	cfg, code := loadDeployment(top, env, stderr)
	if code != ExitOK {
		return code
	}
	repo := *repoFlag
	if repo == "" {
		if repo, err = originRepo(gitDir); err != nil {
			fmt.Fprintf(stderr, "zeroci: deploy: %v; pass --repo owner/name\n", err)
			return ExitUsage
		}
	}
	if !repoRE.MatchString(repo) {
		fmt.Fprintf(stderr, "zeroci: deploy: --repo %q must be owner/name\n", repo)
		return ExitUsage
	}

	db, err := openStateStore(d)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitInternal
	}
	var ps deploy.PreviewStore = emptyPreviewStore{}
	if db != nil {
		defer db.Close()
		ps = db
	}
	sha, err := previewSHA(ctx, *shaFlag, ps, repo, env, gitDir)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: deploy: %v\n", err)
		return ExitInternal
	}

	stateDir := d.Globals.StateDir
	engine := &deploy.Engine{Strategies: strategies.New(strategies.Deps{
		Proxy:    &caddy.Adapter{},
		StateDir: stateDir,
		WorkDir:  func(store.DeployRun) string { return top },
	})}
	pv, err := deploy.BuildPreview(ctx, engine, deploy.PreviewContext{
		Repo: repo, Env: env, SHA: sha, Cfg: cfg, Store: ps, ReadFile: os.ReadFile,
	})
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitInternal
	}
	printPreview(stdout, pv)
	fmt.Fprintln(stdout, renderBadge(ctx, stateDir, pv, sha))
	return ExitOK
}

// loadDeployment loads deployments.<env> of <top>/.zeroci.yml, printing
// every config error as "<path>: <message>; <fix>".
func loadDeployment(top, env string, stderr io.Writer) (config.Deployment, int) {
	path := filepath.Join(top, ".zeroci.yml")
	cfg, diags, err := config.Load(path, config.ParseOptions{})
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: deploy: %v\n", err)
		return config.Deployment{}, ExitUsage
	}
	if diags.HasErrors() {
		for _, dg := range diags {
			if dg.Severity == config.SeverityError {
				fmt.Fprintln(stderr, config.ValidationError{Path: dg.Path, Msg: dg.Message, Fix: dg.Fix}.Error())
			}
		}
		return config.Deployment{}, ExitUsage
	}
	dep, ok := cfg.Deployments[env]
	if !ok {
		fmt.Fprintf(stderr, "zeroci: deploy: %s has no deployments.%s\n", path, env)
		return config.Deployment{}, ExitUsage
	}
	return dep, ExitOK
}

// previewSHA is flagSHA, else the last commit deployed to env, else HEAD.
func previewSHA(ctx context.Context, flagSHA string, ps deploy.PreviewStore, repo, env, gitDir string) (string, error) {
	if flagSHA != "" {
		return flagSHA, nil
	}
	st, ok, err := ps.GetDeployState(ctx, repo, env)
	if err != nil {
		return "", err
	}
	if ok && st.LastSuccessSHA != "" {
		return st.LastSuccessSHA, nil
	}
	return headSHA(gitDir)
}

// printPreview writes pv in deploy order: steps, colors and port, image,
// override, route diff. Sections a strategy leaves empty are left out.
func printPreview(w io.Writer, pv deploy.PlanPreview) {
	fmt.Fprintf(w, "deploy %s (dry run): %s\n", pv.Env, pv.Strategy)
	for i, s := range pv.Steps {
		fmt.Fprintf(w, "  %d. %s\n", i+1, s)
	}
	if pv.TargetColor != "" {
		active := pv.ActiveColor
		if active == "" {
			active = "none"
		}
		fmt.Fprintf(w, "active color: %s\n", active)
		fmt.Fprintf(w, "target color: %s\n", pv.TargetColor)
		fmt.Fprintf(w, "target port: %d\n", pv.TargetPort)
	}
	if pv.Image != "" {
		fmt.Fprintf(w, "image: %s\n", pv.Image)
	}
	if pv.Override != "" {
		fmt.Fprintln(w, "override:")
		fmt.Fprint(w, indent(pv.Override))
	}
	if pv.TargetColor != "" {
		if pv.RouteDiff == "" {
			fmt.Fprintln(w, "route diff: none, the route already points there")
		} else {
			fmt.Fprintln(w, "route diff:")
			fmt.Fprint(w, indent(pv.RouteDiff))
		}
	}
}

// indent prefixes every line of s with two spaces and ends it with a newline.
func indent(s string) string {
	lines := strings.Split(strings.TrimSuffix(s, "\n"), "\n")
	return "  " + strings.Join(lines, "\n  ") + "\n"
}

// renderBadge asks the hub for the badge of a queued deploy of pv and
// returns the line to print. The preview stands without it, so every
// failure becomes a "badge preview unavailable" line.
func renderBadge(ctx context.Context, stateDir string, pv deploy.PlanPreview, sha string) string {
	ac, err := agentconf.Load(stateDir)
	if errors.Is(err, fs.ErrNotExist) {
		return "badge preview unavailable: not connected to a hub; run zeroci connect"
	}
	if err != nil {
		return fmt.Sprintf("badge preview unavailable: %v", err)
	}
	total := len(pv.Steps)
	body, err := json.Marshal(protocol.RenderRequest{
		V: 1, Kind: "deploy_badge", Repo: pv.Repo, Env: pv.Env, Sha: sha,
		State: protocol.RenderRequestStateQueued, StepsTotal: &total,
	})
	if err != nil {
		return fmt.Sprintf("badge preview unavailable: %v", err)
	}
	ctx, cancel := context.WithTimeout(ctx, renderTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(ac.HubURL, "/")+"/v1/render", bytes.NewReader(body))
	if err != nil {
		return fmt.Sprintf("badge preview unavailable: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+ac.Credential)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "zeroci-agent/"+version.Version)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "badge preview unavailable: hub offline"
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxRenderRespBytes))
	if err != nil {
		return "badge preview unavailable: hub offline"
	}
	if res.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &e) // a non-JSON error body still reports the status
		return fmt.Sprintf("badge preview unavailable: hub answered %d %s", res.StatusCode, e.Error)
	}
	var out protocol.RenderResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return fmt.Sprintf("badge preview unavailable: decoding hub answer: %v", err)
	}
	return "badge: " + out.Text
}

// emptyPreviewStore is the store of an agent that has never deployed:
// no state, no ports, so the first port of the range is next.
type emptyPreviewStore struct{}

func (emptyPreviewStore) GetDeployState(context.Context, string, string) (store.DeployState, bool, error) {
	return store.DeployState{}, false, nil
}

func (emptyPreviewStore) GetPortAllocation(_ context.Context, repo, env, color string) (int, error) {
	return 0, fmt.Errorf("cli: port allocation %s/%s %s: %w", repo, env, color, store.ErrNotFound)
}

func (emptyPreviewStore) NextFreePort(context.Context) (int, error) {
	return store.DefaultPortLo, nil
}

// gitCheckout returns the top of the checkout holding dir and its git dir,
// following a ".git" file to a worktree's git dir. It reads files only.
func gitCheckout(dir string) (top, gitDir string, err error) {
	for d := dir; ; {
		p := filepath.Join(d, ".git")
		fi, err := os.Stat(p)
		switch {
		case err == nil && fi.IsDir():
			return d, p, nil
		case err == nil:
			raw, err := os.ReadFile(p)
			if err != nil {
				return "", "", err
			}
			g, ok := strings.CutPrefix(strings.TrimSpace(string(raw)), "gitdir:")
			if !ok {
				return "", "", fmt.Errorf("%s does not name a git dir", p)
			}
			g = strings.TrimSpace(g)
			if !filepath.IsAbs(g) {
				g = filepath.Join(d, g)
			}
			return d, filepath.Clean(g), nil
		case !errors.Is(err, fs.ErrNotExist):
			return "", "", err
		}
		parent := filepath.Dir(d)
		if parent == d {
			return "", "", fmt.Errorf("%s is not inside a git checkout", dir)
		}
		d = parent
	}
}

// commonDir is the dir holding the branches, packed-refs and config of
// gitDir: gitDir itself, or the main repository's for a linked worktree.
func commonDir(gitDir string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(gitDir, "commondir"))
	if errors.Is(err, fs.ErrNotExist) {
		return gitDir, nil
	}
	if err != nil {
		return "", err
	}
	c := strings.TrimSpace(string(raw))
	if !filepath.IsAbs(c) {
		c = filepath.Join(gitDir, c)
	}
	return filepath.Clean(c), nil
}

// headSHA resolves HEAD of gitDir from HEAD, the loose ref and packed-refs.
func headSHA(gitDir string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(gitDir, "HEAD"))
	if err != nil {
		return "", fmt.Errorf("reading HEAD: %w", err)
	}
	head := strings.TrimSpace(string(raw))
	ref, ok := strings.CutPrefix(head, "ref: ")
	if !ok {
		if commitRE.MatchString(head) {
			return head, nil
		}
		return "", fmt.Errorf("HEAD %q is not a commit or a ref", head)
	}
	common, err := commonDir(gitDir)
	if err != nil {
		return "", err
	}
	raw, err = os.ReadFile(filepath.Join(common, filepath.FromSlash(ref)))
	if err == nil {
		if sha := strings.TrimSpace(string(raw)); commitRE.MatchString(sha) {
			return sha, nil
		}
		return "", fmt.Errorf("%s does not hold a commit", ref)
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	packed, err := os.ReadFile(filepath.Join(common, "packed-refs"))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	for _, line := range strings.Split(string(packed), "\n") {
		if sha, name, ok := strings.Cut(line, " "); ok && name == ref && commitRE.MatchString(sha) {
			return sha, nil
		}
	}
	return "", fmt.Errorf("HEAD names %s, which has no commit yet", ref)
}

// githubPrefixes are the forms of a github.com remote URL before owner/name.
var githubPrefixes = []string{"git@github.com:", "ssh://git@github.com/", "https://github.com/", "http://github.com/", "git://github.com/"}

// originRepo returns owner/name of the github.com origin remote of gitDir,
// read from its config file.
func originRepo(gitDir string) (string, error) {
	common, err := commonDir(gitDir)
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(filepath.Join(common, "config"))
	if err != nil {
		return "", fmt.Errorf("reading git config: %w", err)
	}
	inOrigin := false
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			inOrigin = line == `[remote "origin"]`
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !inOrigin || !ok || strings.TrimSpace(key) != "url" {
			continue
		}
		url := strings.TrimSpace(val)
		for _, p := range githubPrefixes {
			if rest, ok := strings.CutPrefix(url, p); ok {
				repo := strings.TrimSuffix(strings.TrimSuffix(rest, "/"), ".git")
				if repoRE.MatchString(repo) {
					return repo, nil
				}
			}
		}
		return "", fmt.Errorf("origin %s is not a github.com repository", url)
	}
	return "", errors.New("the checkout has no origin remote")
}
