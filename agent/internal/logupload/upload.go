// Package logupload sends a finished job's log to the hub: redacted, capped at
// MaxBytes of log and of gzip, gzipped and PUT to /v1/logs/<run>/<job> with
// the agent credential.
package logupload

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/KCuppens/hookci/agent/internal/redact"
)

// DefaultMaxBytes is the hub's log cap (QUOTAS.logBytes). The hub applies it
// to both the declared log size and the gzipped body.
const DefaultMaxBytes = 10 << 20

// gzipHeadroom is the room left under the cap for the truncation marker,
// a deflate flush and the gzip trailer.
const gzipHeadroom = 4 << 10

// TruncationMarker ends a log cut at the cap.
const TruncationMarker = "\n[hookci: log truncated at 10 MB]\n"

// retries is how many times a 5xx or network failure is retried.
const retries = 3

var backoffs = [retries]time.Duration{time.Second, 2 * time.Second, 4 * time.Second}

// redactor masks builtin patterns and registered secrets (redact.AddSecret).
// The job log file is already redacted with the run's full config; this pass
// catches anything written around it.
var redactor, _ = redact.New(nil, nil)

// Redact masks a run of whole log lines the way Upload does, so the live
// log tail shows what the uploaded log will. A trailing partial line is
// masked on its own, as at the end of an upload.
func Redact(b []byte) []byte {
	var out bytes.Buffer
	w := redactor.Writer(&out)
	// A bytes.Buffer never fails a write.
	_, _ = w.Write(b)
	_ = w.Close()
	return out.Bytes()
}

// Uploader PUTs job logs to the hub.
type Uploader struct {
	HubURL   string        // e.g. https://ci.hookci.com
	Token    func() string // agent credential, hci_agent_...
	HTTP     *http.Client  // nil: http.DefaultClient
	MaxBytes int64         // <= 0: DefaultMaxBytes

	sleep func(context.Context, time.Duration) error // nil: sleepCtx; tests skip the wait
}

// Result is what was uploaded: Bytes of log kept (before the marker and
// gzip) and whether the log was cut at the cap.
type Result struct {
	Bytes     int64
	Truncated bool
}

// Upload redacts, caps and gzips r and PUTs it as the log of job in runID.
// 5xx and network errors are retried with backoff; 4xx are not.
func (u *Uploader) Upload(ctx context.Context, runID, job string, r io.Reader) (Result, error) {
	endpoint, err := logURL(u.HubURL, runID, job)
	if err != nil {
		return Result{}, err
	}
	body, res, err := u.encode(r)
	if err != nil {
		return Result{}, err
	}
	sleep := u.sleep
	if sleep == nil {
		sleep = sleepCtx
	}
	for attempt := 0; ; attempt++ {
		retry, err := u.put(ctx, endpoint, body, res)
		if err == nil {
			return res, nil
		}
		if !retry || attempt == retries {
			return Result{}, err
		}
		if err := sleep(ctx, backoffs[attempt]); err != nil {
			return Result{}, fmt.Errorf("logupload: %s/%s: %w", runID, job, err)
		}
	}
}

// encode returns the gzipped, redacted and capped log. Both the log and its
// gzip stay within the limit, so an incompressible log is cut before the
// gzip outgrows it.
func (u *Uploader) encode(r io.Reader) ([]byte, Result, error) {
	limit := u.MaxBytes
	if limit <= 0 {
		limit = DefaultMaxBytes
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	cw := &capWriter{gz: gz, out: &buf, left: limit, room: limit - gzipHeadroom}
	rw := redactor.Writer(cw)
	_, err := io.Copy(rw, r)
	if err == nil {
		err = rw.Close()
	}
	switch {
	case errors.Is(err, errCapped):
		if _, err := io.WriteString(gz, TruncationMarker); err != nil {
			return nil, Result{}, fmt.Errorf("logupload: compress: %w", err)
		}
	case err != nil:
		return nil, Result{}, fmt.Errorf("logupload: read log: %w", err)
	}
	if err := gz.Close(); err != nil {
		return nil, Result{}, fmt.Errorf("logupload: compress: %w", err)
	}
	return buf.Bytes(), Result{Bytes: limit - cw.left, Truncated: cw.capped}, nil
}

// put sends one attempt. retry reports whether a failure is worth retrying.
func (u *Uploader) put(ctx context.Context, endpoint string, body []byte, res Result) (retry bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, bytes.NewReader(body))
	if err != nil {
		return false, fmt.Errorf("logupload: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+u.Token())
	req.Header.Set("Content-Type", "text/plain; charset=utf-8")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("X-Hookci-Log-Bytes", strconv.FormatInt(res.Bytes, 10))
	truncated := "0"
	if res.Truncated {
		truncated = "1"
	}
	req.Header.Set("X-Hookci-Log-Truncated", truncated)
	client := u.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return ctx.Err() == nil, fmt.Errorf("logupload: put %s: %w", endpoint, err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return false, nil
	case resp.StatusCode >= 500:
		return true, fmt.Errorf("logupload: put %s: hub returned %s", endpoint, resp.Status)
	default:
		return false, fmt.Errorf("logupload: put %s: hub returned %s", endpoint, resp.Status)
	}
}

// logURL is <hub>/v1/logs/<runID>/<job> on the hub's http(s) origin.
func logURL(hubURL, runID, job string) (string, error) {
	u, err := url.Parse(hubURL)
	if err != nil {
		return "", fmt.Errorf("logupload: hub url: %w", err)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", fmt.Errorf("logupload: hub url %q: scheme must be http or https", hubURL)
	}
	if u.Host == "" {
		return "", fmt.Errorf("logupload: hub url %q: missing host", hubURL)
	}
	u.Path = "/v1/logs/" + url.PathEscape(runID) + "/" + url.PathEscape(job)
	u.RawQuery, u.Fragment = "", ""
	return u.String(), nil
}

var errCapped = errors.New("logupload: log cap reached")

// capWriter passes at most left bytes to gz and keeps gz's output in out
// within room bytes, then fails with errCapped.
type capWriter struct {
	gz      *gzip.Writer
	out     *bytes.Buffer // gz's output
	left    int64         // log bytes still allowed
	room    int64         // gzip bytes allowed in out
	pending int64         // log bytes written to gz since its last flush
	capped  bool
}

func (w *capWriter) Write(p []byte) (int, error) {
	n := min(int64(len(p)), w.left)
	if w.worst(w.pending+n) > w.room {
		// Flush so out holds everything written, then take only what is
		// sure to fit even if it does not compress.
		if err := w.gz.Flush(); err != nil {
			return 0, err
		}
		w.pending = 0
		n = min(n, max(0, (w.room-int64(w.out.Len())-13)*16384/16389))
	}
	written, err := w.gz.Write(p[:n])
	w.left -= int64(written)
	w.pending += int64(written)
	if err != nil {
		return written, err
	}
	if written < len(p) {
		w.capped = true
		return written, errCapped
	}
	return written, nil
}

// worst bounds the size of out once k more unflushed log bytes are
// compressed: deflate falls back to stored blocks, 5 bytes of header per
// 16 KiB block, as zlib's deflateBound counts.
func (w *capWriter) worst(k int64) int64 {
	return int64(w.out.Len()) + k + k>>12 + k>>14 + 13
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
