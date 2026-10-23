package daemon

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/logpipe"
	"github.com/KCuppens/hookci/agent/internal/logupload"
	"github.com/KCuppens/hookci/agent/internal/scheduler"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// setupRunner is a JobRunner whose setup writes a setup log.
type setupRunner struct {
	scheduler.JobRunner
	runDir string
}

func (r setupRunner) RunSetup(context.Context, store.Run) (scheduler.JobOutcome, error) {
	path := logpipe.LogPath(r.runDir, store.SetupJob)
	if err := writeTree(filepath.Dir(path), map[string]string{filepath.Base(path): "setup output\n"}); err != nil {
		return scheduler.JobOutcome{}, err
	}
	return scheduler.JobOutcome{}, nil
}

// A run planned with a setup job has its setup log uploaded (or left local),
// because the hub has a setup row for it. A run planned without one, a retry
// of a run an older agent planned, has no such row: the hub must get no
// setup log and the outcome no `logs: local`.
func TestLogRunnerSetupLog(t *testing.T) {
	tests := []struct {
		name      string
		jobs      []store.Job
		local     bool
		wantPuts  int
		wantLocal bool
	}{
		{"setup planned uploads", store.WithSetup([]store.Job{{Name: "unit"}}), false, 1, false},
		{"setup planned, logs local", store.WithSetup([]store.Job{{Name: "unit"}}), true, 0, true},
		{"no setup job uploads nothing", []store.Job{{Name: "unit"}}, false, 0, false},
		{"no setup job, logs local says nothing", []store.Job{{Name: "unit"}}, true, 0, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var paths []string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				mu.Lock()
				paths = append(paths, r.URL.Path)
				mu.Unlock()
				w.WriteHeader(http.StatusNoContent)
			}))
			defer srv.Close()

			st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer st.Close()
			run := store.Run{ID: "run_1", Repo: "acme/app", SHA: headSHA, Ref: "refs/heads/main", Event: "push", Attempt: 1, Kind: "check", TrustDomain: "trusted:acme/app"}
			if err := st.CreateRun(context.Background(), run, tc.jobs); err != nil {
				t.Fatal(err)
			}

			runDir := t.TempDir()
			r := &logRunner{
				JobRunner: setupRunner{runDir: runDir},
				st:        st,
				up:        &logupload.Uploader{HubURL: srv.URL, Token: func() string { return "hci_agent_x" }},
				runDir:    runDir,
				local:     tc.local,
				log:       slog.New(slog.DiscardHandler),
			}
			out, err := r.RunSetup(context.Background(), run)
			if err != nil {
				t.Fatal(err)
			}
			mu.Lock()
			defer mu.Unlock()
			if len(paths) != tc.wantPuts {
				t.Fatalf("log PUTs = %q, want %d", paths, tc.wantPuts)
			}
			if tc.wantPuts == 1 && paths[0] != "/v1/logs/run_1/setup" {
				t.Errorf("log PUT path = %q, want /v1/logs/run_1/setup", paths[0])
			}
			if out.LogsLocal != tc.wantLocal {
				t.Errorf("LogsLocal = %v, want %v", out.LogsLocal, tc.wantLocal)
			}
		})
	}
}
