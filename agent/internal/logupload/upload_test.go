package logupload

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type hubCall struct {
	path   string
	header http.Header
	body   string // gunzipped
}

type fakeHub struct {
	mu       sync.Mutex
	statuses []int // per call; the last one repeats
	calls    []hubCall
}

func (h *fakeHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	zr, err := gzip.NewReader(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(zr)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if r.Method != http.MethodPut {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	h.calls = append(h.calls, hubCall{path: r.URL.Path, header: r.Header.Clone(), body: string(body)})
	status := h.statuses[min(len(h.calls), len(h.statuses))-1]
	w.WriteHeader(status)
}

func TestUpload(t *testing.T) {
	const limit = DefaultMaxBytes
	big := strings.Repeat(strings.Repeat("a", 1023)+"\n", 11<<10) // 11 MB
	token := "ghs_" + strings.Repeat("Z", 36)
	tests := []struct {
		name      string
		log       string
		statuses  []int
		wantErr   string
		wantCalls int
		wantBody  string
		wantBytes string
		wantTrunc string
	}{
		{
			name:      "11 MB is cut to 10 MB plus the marker",
			log:       big,
			statuses:  []int{204},
			wantCalls: 1,
			wantBody:  big[:limit] + TruncationMarker,
			wantBytes: "10485760",
			wantTrunc: "1",
		},
		{
			name:      "ghs token is redacted",
			log:       "cloning with " + token + "\ndone\n",
			statuses:  []int{204},
			wantCalls: 1,
			wantBody:  "cloning with ***\ndone\n",
			wantBytes: "22",
			wantTrunc: "0",
		},
		{
			name:      "500 then 200 retries once",
			log:       "ok\n",
			statuses:  []int{500, 200},
			wantCalls: 2,
			wantBody:  "ok\n",
			wantBytes: "3",
			wantTrunc: "0",
		},
		{
			name:      "413 is not retried",
			log:       "ok\n",
			statuses:  []int{413},
			wantErr:   "413",
			wantCalls: 1,
			wantBody:  "ok\n",
			wantBytes: "3",
			wantTrunc: "0",
		},
		{
			name:      "5xx gives up after three retries",
			log:       "ok\n",
			statuses:  []int{503},
			wantErr:   "503",
			wantCalls: 1 + retries,
			wantBody:  "ok\n",
			wantBytes: "3",
			wantTrunc: "0",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			hub := &fakeHub{statuses: tc.statuses}
			srv := httptest.NewServer(hub)
			defer srv.Close()
			var slept []time.Duration
			u := &Uploader{
				HubURL: srv.URL,
				Token:  func() string { return "hci_agent_secret" },
				HTTP:   srv.Client(),
				sleep: func(_ context.Context, d time.Duration) error {
					slept = append(slept, d)
					return nil
				},
			}
			res, err := u.Upload(context.Background(), "run_1", "build", strings.NewReader(tc.log))
			if tc.wantErr == "" && err != nil {
				t.Fatalf("Upload: %v", err)
			}
			if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("Upload err = %v, want %q", err, tc.wantErr)
			}
			if len(hub.calls) != tc.wantCalls {
				t.Fatalf("hub saw %d PUTs, want %d", len(hub.calls), tc.wantCalls)
			}
			if len(slept) != tc.wantCalls-1 {
				t.Errorf("slept %v, want %d backoffs", slept, tc.wantCalls-1)
			}
			c := hub.calls[len(hub.calls)-1]
			if c.path != "/v1/logs/run_1/build" {
				t.Errorf("path = %q", c.path)
			}
			if got := c.header.Get("Authorization"); got != "Bearer hci_agent_secret" {
				t.Errorf("Authorization = %q", got)
			}
			if got := c.header.Get("Content-Encoding"); got != "gzip" {
				t.Errorf("Content-Encoding = %q", got)
			}
			if got := c.header.Get("X-Hookci-Log-Bytes"); got != tc.wantBytes {
				t.Errorf("X-Hookci-Log-Bytes = %q, want %q", got, tc.wantBytes)
			}
			if got := c.header.Get("X-Hookci-Log-Truncated"); got != tc.wantTrunc {
				t.Errorf("X-Hookci-Log-Truncated = %q, want %q", got, tc.wantTrunc)
			}
			if c.body != tc.wantBody {
				t.Errorf("body = %d bytes ending %q, want %d bytes ending %q",
					len(c.body), c.body[max(0, len(c.body)-40):], len(tc.wantBody), tc.wantBody[max(0, len(tc.wantBody)-40):])
			}
			if err == nil && (res.Truncated != (tc.wantTrunc == "1")) {
				t.Errorf("Result.Truncated = %v", res.Truncated)
			}
		})
	}
}

func TestLogURL(t *testing.T) {
	tests := []struct{ in, want, err string }{
		{"https://ci.hookci.com", "https://ci.hookci.com/v1/logs/run_1/build", ""},
		{"https://ci.hookci.com/", "https://ci.hookci.com/v1/logs/run_1/build", ""},
		{"http://127.0.0.1:8787", "http://127.0.0.1:8787/v1/logs/run_1/build", ""},
		{"wss://ci.hookci.com", "", "scheme must be http or https"},
		{"https://", "", "missing host"},
	}
	for _, tc := range tests {
		got, err := logURL(tc.in, "run_1", "build")
		if tc.err != "" {
			if err == nil || !strings.Contains(err.Error(), tc.err) {
				t.Errorf("logURL(%q) err = %v, want %q", tc.in, err, tc.err)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("logURL(%q) = %q, %v, want %q", tc.in, got, err, tc.want)
		}
	}
}

func TestRedactMatchesUpload(t *testing.T) {
	token := "ghs_" + strings.Repeat("Z", 36)
	got := string(Redact([]byte("token " + token + "\ntail " + token)))
	if strings.Contains(got, token) || got != "token ***\ntail ***" {
		t.Errorf("Redact = %q; want both tokens masked", got)
	}
}

// TestEncodeIncompressibleFitsHubCap: random bytes do not compress, so
// 10 MB of them gzip to more than the hub's cap; the log is cut short so
// the body still fits.
func TestEncodeIncompressibleFitsHubCap(t *testing.T) {
	log := make([]byte, 11<<20)
	if _, err := rand.Read(log); err != nil {
		t.Fatal(err)
	}
	for i := 1023; i < len(log); i += 1024 {
		log[i] = '\n'
	}
	body, res, err := (&Uploader{}).encode(bytes.NewReader(log))
	if err != nil {
		t.Fatal(err)
	}
	if len(body) > DefaultMaxBytes {
		t.Fatalf("gzip body = %d bytes, want <= %d", len(body), DefaultMaxBytes)
	}
	if !res.Truncated || res.Bytes < DefaultMaxBytes-64<<10 {
		t.Fatalf("Result = %+v, want truncated just under %d", res, DefaultMaxBytes)
	}
	zr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	if want := append(log[:res.Bytes:res.Bytes], TruncationMarker...); !bytes.Equal(got, want) {
		t.Fatalf("body = %d bytes, want the first %d log bytes and the marker", len(got), res.Bytes)
	}
}

func TestUploadCancelledDuringBackoff(t *testing.T) {
	hub := &fakeHub{statuses: []int{502}}
	srv := httptest.NewServer(hub)
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	u := &Uploader{HubURL: srv.URL, Token: func() string { return "t" }, HTTP: srv.Client(),
		sleep: func(ctx context.Context, _ time.Duration) error { cancel(); return ctx.Err() }}
	if _, err := u.Upload(ctx, "run_1", "build", bytes.NewReader([]byte("x\n"))); err == nil {
		t.Fatal("Upload succeeded after cancel")
	}
	if len(hub.calls) != 1 {
		t.Errorf("hub saw %d PUTs, want 1", len(hub.calls))
	}
}
