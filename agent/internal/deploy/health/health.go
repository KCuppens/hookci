// Package health gates a deploy on the new version answering its HTTP health
// URL with the expected status.
package health

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
)

const (
	defaultExpect   = 200
	defaultRetries  = 40
	defaultInterval = 2 * time.Second
	maxProbeTimeout = 10 * time.Second
	maxBody         = 512
	maxRedirects    = 10
)

// Spec is one health check: deployments.<env>.health with {port} resolved
// from Port.
type Spec struct {
	Env      string
	URL      string // may contain {port}
	Port     int
	Expect   int           // default 200
	Retries  int           // default 40
	Interval time.Duration // default 2s
}

func (s Spec) withDefaults() Spec {
	if s.Expect == 0 {
		s.Expect = defaultExpect
	}
	if s.Retries <= 0 {
		s.Retries = defaultRetries
	}
	if s.Interval <= 0 {
		s.Interval = defaultInterval
	}
	return s
}

// Checker probes health URLs. A nil Client uses the zero http.Client and a
// nil Clock uses the wall clock.
type Checker struct {
	Client *http.Client
	Clock  clock.Clock
}

// ExpandURL replaces every {port} in raw with the decimal port.
func ExpandURL(raw string, port int) string {
	return strings.ReplaceAll(raw, "{port}", strconv.Itoa(port))
}

// Wait probes s up to s.Retries times, sleeping s.Interval between attempts,
// and returns nil on the first response with status s.Expect. It returns
// ctx.Err() as soon as ctx is done. When every attempt fails the error names
// the config path, the last outcome and the fix.
func (c *Checker) Wait(ctx context.Context, s Spec) error {
	s = s.withDefaults()
	clk := c.Clock
	if clk == nil {
		clk = clock.Real{}
	}

	var outcome, body string
	for attempt := 1; attempt <= s.Retries; attempt++ {
		status, b, err := c.Probe(ctx, s)
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if err == nil && status == s.Expect {
			return nil
		}
		if err != nil {
			outcome, body = describe(err), ""
		} else {
			outcome, body = strconv.Itoa(status), b
		}
		if attempt == s.Retries {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-clk.After(s.Interval):
		}
	}
	return fmt.Errorf("deployments.%s.health: %s after %d tries, last body: %s; check health.url or raise health.retries",
		s.Env, outcome, s.Retries, body)
}

// Probe issues one GET to the expanded health URL with a timeout of
// min(Interval, 10s) and returns the status and at most the first 512 bytes
// of the body. Redirects are followed only to loopback hosts.
func (c *Checker) Probe(ctx context.Context, s Spec) (status int, body string, err error) {
	s = s.withDefaults()
	ctx, cancel := context.WithTimeout(ctx, min(s.Interval, maxProbeTimeout))
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ExpandURL(s.URL, s.Port), nil)
	if err != nil {
		return 0, "", fmt.Errorf("health: %w", err)
	}
	client := http.Client{}
	if c.Client != nil {
		client = *c.Client
	}
	client.CheckRedirect = loopbackRedirectsOnly
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", fmt.Errorf("health: %w", err)
	}
	defer resp.Body.Close()

	b, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return resp.StatusCode, string(b), fmt.Errorf("health: reading body: %w", err)
	}
	return resp.StatusCode, string(b), nil
}

// loopbackRedirectsOnly follows redirects that stay on a loopback host and
// otherwise hands the redirect response back as the probe result.
func loopbackRedirectsOnly(req *http.Request, via []*http.Request) error {
	if len(via) >= maxRedirects || !isLoopback(req.URL.Hostname()) {
		return http.ErrUseLastResponse
	}
	return nil
}

func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// describe renders a failed probe for the user-facing error.
func describe(err error) string {
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return "connection refused"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	}
	var uerr *url.Error
	if errors.As(err, &uerr) {
		return uerr.Err.Error()
	}
	return err.Error()
}
