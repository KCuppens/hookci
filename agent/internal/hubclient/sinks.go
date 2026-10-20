package hubclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	// sinkAPITimeout bounds one sink API call. A test delivery waits on the
	// provider's answer, so it is longer than the info timeout.
	sinkAPITimeout = 30 * time.Second
	// maxSinkRespBytes bounds a sink API answer; ten sinks are a few KB.
	maxSinkRespBytes = 1 << 20
)

// ErrRepoNotBound means the hub refused a sink call because no agent of
// this agent's installation runs the repo.
var ErrRepoNotBound = errors.New("repo not bound to this agent's installation")

// Sink is a sink config as the hub shows it: no secret, target redacted.
type Sink struct {
	ID    string  `json:"id"`
	Kind  string  `json:"kind"`
	Repo  string  `json:"repo"`
	Label *string `json:"label"`
	// Target is "chat <id>" for Telegram, the URL's origin and start of its
	// path for a webhook.
	Target     string  `json:"target"`
	CreatedAt  string  `json:"created_at"`
	DisabledAt *string `json:"disabled_at"`
	// LastError is why the hub disabled the sink; nil while enabled.
	LastError *string `json:"last_error"`
}

// AddSinkRequest is the body of POST /v1/agent/sinks. Telegram needs
// BotToken and ChatID, a webhook needs URL; the hub refuses the fields of
// the other kind, so empty ones are left out.
type AddSinkRequest struct {
	Kind     string `json:"kind,omitempty"`
	Repo     string `json:"repo,omitempty"`
	BotToken string `json:"bot_token,omitempty"`
	ChatID   string `json:"chat_id,omitempty"`
	URL      string `json:"url,omitempty"`
	Label    string `json:"label,omitempty"`
}

// AddSinkResponse is the hub's answer to an add. GeneratedSecret is the
// webhook signing secret, given in this answer only.
type AddSinkResponse struct {
	Sink            Sink   `json:"sink"`
	GeneratedSecret string `json:"generated_secret,omitempty"`
}

// APIError is a sink API answer other than 2xx and repo_not_bound.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	msg := fmt.Sprintf("hubclient: hub answered HTTP %d", e.Status)
	if e.Code != "" {
		msg += " " + e.Code
	}
	if e.Message != "" {
		msg += ": " + e.Message
	}
	return msg
}

// ListSinks returns every sink config of repo, disabled ones too.
func (c *Client) ListSinks(ctx context.Context, repo string) ([]Sink, error) {
	out := struct {
		Sinks []Sink `json:"sinks"`
	}{Sinks: []Sink{}}
	if err := c.sinkAPI(ctx, http.MethodGet, "/v1/agent/sinks?repo="+url.QueryEscape(repo), nil, http.StatusOK, &out); err != nil {
		return nil, fmt.Errorf("hubclient: list sinks: %w", err)
	}
	return out.Sinks, nil
}

// AddSink adds a sink config and returns it with the webhook secret.
func (c *Client) AddSink(ctx context.Context, req AddSinkRequest) (AddSinkResponse, error) {
	var out AddSinkResponse
	if err := c.sinkAPI(ctx, http.MethodPost, "/v1/agent/sinks", req, http.StatusCreated, &out); err != nil {
		return AddSinkResponse{}, fmt.Errorf("hubclient: add sink: %w", err)
	}
	return out, nil
}

// RemoveSink deletes the sink config id.
func (c *Client) RemoveSink(ctx context.Context, id string) error {
	if err := c.sinkAPI(ctx, http.MethodDelete, "/v1/agent/sinks/"+url.PathEscape(id), nil, http.StatusNoContent, nil); err != nil {
		return fmt.Errorf("hubclient: remove sink: %w", err)
	}
	return nil
}

// TestSink has the hub send a test delivery through sink id and returns
// how the provider took it: "ok", "retry" or "fail", followed by the hub's
// detail in parentheses when it gives one, as in "fail (http_404)".
func (c *Client) TestSink(ctx context.Context, id string) (string, error) {
	var out struct {
		Result string `json:"result"`
		Detail string `json:"detail"`
	}
	if err := c.sinkAPI(ctx, http.MethodPost, "/v1/agent/sinks/"+url.PathEscape(id)+"/test", nil, http.StatusOK, &out); err != nil {
		return "", fmt.Errorf("hubclient: test sink: %w", err)
	}
	if out.Result == "" {
		return "", errors.New("hubclient: test sink: hub answer lacks result")
	}
	if out.Detail != "" {
		return out.Result + " (" + out.Detail + ")", nil
	}
	return out.Result, nil
}

// sinkAPI calls the agent sink API with the agent credential, expects the
// status want and decodes the answer into out unless out is nil. It never
// logs the body: an add carries the bot token.
func (c *Client) sinkAPI(ctx context.Context, method, path string, body any, want int, out any) error {
	ctx, cancel := context.WithTimeout(ctx, sinkAPITimeout)
	defer cancel()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.cfg.HubURL, "/")+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.cfg.Credential)
	req.Header.Set("User-Agent", "zeroci-agent/"+c.cfg.Version)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxSinkRespBytes))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	if res.StatusCode != want {
		var e struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &e) // a non-JSON error body still reports the status
		if res.StatusCode == http.StatusForbidden && e.Error == "repo_not_bound" {
			return ErrRepoNotBound
		}
		return &APIError{Status: res.StatusCode, Code: e.Error, Message: e.Message}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}
