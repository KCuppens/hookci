package trigger

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/KCuppens/hookci/agent/internal/config"
)

// RefChecker answers the GitHub questions a deploy trigger must pass.
type RefChecker interface {
	// IsProtected reports whether branch has GitHub branch protection.
	IsProtected(ctx context.Context, repo, branch string) (bool, error)
	// ContainsSHA reports whether sha is reachable from ref.
	ContainsSHA(ctx context.Context, repo, ref, sha string) (bool, error)
	// ChangedFiles lists the files changed between base and head;
	// truncated is set when GitHub capped the list.
	ChangedFiles(ctx context.Context, repo, base, head string) (files []string, truncated bool, err error)
}

// DefaultGitHubURL is the GitHub REST API root.
const DefaultGitHubURL = "https://api.github.com"

// compareFileCap is the most files GitHub's compare API lists.
const compareFileCap = 300

// configFile is the deploy configuration at the root of a repository.
const configFile = ".hookci.yml"

// GitHubRefChecker is a RefChecker over the GitHub REST API. It also loads
// a repository's .hookci.yml at a commit.
type GitHubRefChecker struct {
	BaseURL string       // "" means DefaultGitHubURL
	HTTP    *http.Client // nil means http.DefaultClient
	// Token returns a fetch token for repo, the M1 token_request{purpose:
	// fetch}.
	Token func(ctx context.Context, repo string) (string, error)
}

var _ RefChecker = (*GitHubRefChecker)(nil)

// IsProtected implements RefChecker. A branch GitHub does not know is not
// protected.
func (g *GitHubRefChecker) IsProtected(ctx context.Context, repo, branch string) (bool, error) {
	var body struct {
		Protected bool `json:"protected"`
	}
	found, err := g.getJSON(ctx, repo, "/repos/"+repo+"/branches/"+escapeRef(branch), &body)
	if err != nil || !found {
		return false, err
	}
	return body.Protected, nil
}

// ContainsSHA implements RefChecker: sha is on ref when comparing ref to sha
// is identical or behind. A ref or sha GitHub does not know is not
// contained.
func (g *GitHubRefChecker) ContainsSHA(ctx context.Context, repo, ref, sha string) (bool, error) {
	var body struct {
		Status string `json:"status"`
	}
	found, err := g.getJSON(ctx, repo, comparePath(repo, ref, sha), &body)
	if err != nil || !found {
		return false, err
	}
	return body.Status == "identical" || body.Status == "behind", nil
}

// ChangedFiles implements RefChecker. GitHub lists at most 300 files, so a
// list that long is reported truncated.
func (g *GitHubRefChecker) ChangedFiles(ctx context.Context, repo, base, head string) ([]string, bool, error) {
	var body struct {
		Files []struct {
			Filename string `json:"filename"`
		} `json:"files"`
	}
	path := comparePath(repo, base, head)
	found, err := g.getJSON(ctx, repo, path, &body)
	if err != nil {
		return nil, false, err
	}
	if !found {
		return nil, false, Permanent(fmt.Errorf("github %s: %d", path, http.StatusNotFound))
	}
	files := make([]string, len(body.Files))
	for i, f := range body.Files {
		files[i] = f.Filename
	}
	return files, len(files) >= compareFileCap, nil
}

// LoadConfig returns repo's .hookci.yml at sha. A commit without one has an
// empty configuration; one that does not parse is an error naming its
// problems.
func (g *GitHubRefChecker) LoadConfig(ctx context.Context, repo, sha string) (*config.Config, error) {
	path := "/repos/" + repo + "/contents/" + configFile + "?ref=" + url.QueryEscape(sha)
	resp, err := g.get(ctx, repo, path, "application/vnd.github.raw+json")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return &config.Config{}, nil
	}
	if err := statusErr(path, resp); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("github %s: read: %w", path, err)
	}
	cfg, diags := config.Parse(data, config.ParseOptions{})
	if diags.HasErrors() {
		return nil, Permanent(fmt.Errorf("%s at %s is invalid:\n%s", configFile, short(sha), diags.Format(configFile)))
	}
	return cfg, nil
}

// getJSON GETs path and decodes the 2xx body into out. found is false on 404.
func (g *GitHubRefChecker) getJSON(ctx context.Context, repo, path string, out any) (found bool, err error) {
	resp, err := g.get(ctx, repo, path, "application/vnd.github+json")
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if err := statusErr(path, resp); err != nil {
		return false, err
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return false, fmt.Errorf("github %s: decode: %w", path, err)
	}
	return true, nil
}

func (g *GitHubRefChecker) get(ctx context.Context, repo, path, accept string) (*http.Response, error) {
	base := g.BaseURL
	if base == "" {
		base = DefaultGitHubURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(base, "/")+path, nil)
	if err != nil {
		return nil, fmt.Errorf("github %s: %w", path, err)
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if g.Token != nil {
		token, err := g.Token(ctx, repo)
		if err != nil {
			return nil, fmt.Errorf("github %s: token: %w", path, err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := g.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("github %s: %w", path, err)
	}
	return resp, nil
}

// statusErr is the error of a non-2xx response other than 404. A 4xx is
// permanent except 401 and 403, which an expired token or a rate limit
// also answers, and 408 and 429.
func statusErr(path string, resp *http.Response) error {
	code := resp.StatusCode
	if code >= 200 && code <= 299 {
		return nil
	}
	err := fmt.Errorf("github %s: %d", path, code)
	switch code {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusRequestTimeout, http.StatusTooManyRequests:
		return err
	}
	if code >= 400 && code <= 499 {
		return Permanent(err)
	}
	return err
}

func comparePath(repo, base, head string) string {
	return "/repos/" + repo + "/compare/" + escapeRef(base) + "..." + escapeRef(head)
}

// escapeRef escapes each segment of a ref, keeping its slashes.
func escapeRef(ref string) string {
	segs := strings.Split(ref, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.Join(segs, "/")
}
