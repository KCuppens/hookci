package hubclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/version"
)

const (
	infoTimeout = 10 * time.Second
	// maxInfoBytes bounds the /v1/info body; the real one is under 300 bytes.
	maxInfoBytes = 64 << 10
	hubName      = "zeroci-hub"
)

// ErrNotAHub means the URL answered /v1/info but not as a zeroci hub.
var ErrNotAHub = errors.New("hubclient: not a zeroci hub")

// HubInfo is the body of GET /v1/info.
type HubInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	// Mode is "shared" or "self_hosted".
	Mode string `json:"mode"`
	// ProtocolVersions is the oldest and newest protocol version the hub
	// speaks.
	ProtocolVersions []int `json:"protocol_versions"`
	GithubApp        struct {
		Slug string `json:"slug"`
	} `json:"github_app"`
	Slack struct {
		Enabled bool `json:"enabled"`
	} `json:"slack"`
}

// FetchInfo reads GET <baseURL>/v1/info within 10 s. A body naming another
// service returns ErrNotAHub.
func FetchInfo(ctx context.Context, c *http.Client, baseURL string) (HubInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, infoTimeout)
	defer cancel()
	base := strings.TrimRight(baseURL, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/v1/info", nil)
	if err != nil {
		return HubInfo{}, fmt.Errorf("hubclient: info: %w", err)
	}
	req.Header.Set("User-Agent", "zeroci-agent/"+version.Version)
	res, err := c.Do(req)
	if err != nil {
		return HubInfo{}, fmt.Errorf("hubclient: info: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return HubInfo{}, fmt.Errorf("hubclient: info: GET /v1/info answered HTTP %d", res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxInfoBytes))
	if err != nil {
		return HubInfo{}, fmt.Errorf("hubclient: info: read response: %w", err)
	}
	var info HubInfo
	if err := json.Unmarshal(raw, &info); err != nil || info.Name != hubName {
		return HubInfo{}, fmt.Errorf("%w: %s/v1/info", ErrNotAHub, base)
	}
	if pv := info.ProtocolVersions; len(pv) != 2 || pv[0] > pv[1] {
		return HubInfo{}, fmt.Errorf("hubclient: info: protocol_versions %v is not [oldest, newest]", pv)
	}
	return info, nil
}
