package store

import (
	"context"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/runstats"
)

func TestListFinishedRuns(t *testing.T) {
	ctx := context.Background()
	now := t0
	s, err := Open(filepath.Join(t.TempDir(), "agent.db"), WithClock(func() time.Time { return now }))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	at := func(d time.Duration) time.Time { return t0.Add(d) }

	// check runs a check from queued through running to `to`, stamping
	// started_at at start and finished_at at end (zero end: still running).
	check := func(id, repo string, start, end time.Duration, to RunState) {
		t.Helper()
		r := testRun(id)
		r.Repo, r.TrustDomain = repo, "trusted:"+repo
		now = at(0)
		mustCreateRun(t, s, r)
		now = at(start)
		if err := s.Transition(ctx, id, []RunState{RunQueued}, RunRunning, ""); err != nil {
			t.Fatal(err)
		}
		if end == 0 {
			return
		}
		now = at(end)
		if err := s.Transition(ctx, id, []RunState{RunRunning}, to, ""); err != nil {
			t.Fatal(err)
		}
	}
	deploy := func(id string, start, end time.Duration, to string) {
		t.Helper()
		if err := s.InsertDeployRun(ctx, DeployRun{RunID: id, Repo: "acme/web", Env: "production", SHA: "sha-" + id,
			Ref: "refs/heads/main", Strategy: "compose-bluegreen", State: DeployQueued, CreatedAt: at(0)}); err != nil {
			t.Fatal(err)
		}
		if start != 0 {
			if err := s.SetDeployRunState(ctx, id, DeployRunning, "", at(start)); err != nil {
				t.Fatal(err)
			}
		}
		if end != 0 {
			if err := s.SetDeployRunState(ctx, id, to, "", at(end)); err != nil {
				t.Fatal(err)
			}
		}
	}

	since, until := at(time.Hour), at(10*time.Hour)
	check("c_old", "acme/web", 5*time.Minute, 10*time.Minute, RunSuccess)
	check("c_ok", "acme/web", 2*time.Hour, 2*time.Hour+90*time.Second, RunSuccess)
	check("c_failed", "acme/web", 3*time.Hour, 3*time.Hour+30*time.Second, RunFailed)
	check("c_api", "acme/api", 4*time.Hour, 4*time.Hour+time.Minute, RunSuccess)
	check("c_running", "acme/web", 5*time.Hour, 0, "")
	check("c_late", "acme/web", 10*time.Hour+time.Minute, 11*time.Hour, RunSuccess)
	now = at(0)
	mustCreateRun(t, s, testRun("c_cancelled"))
	now = at(2 * time.Hour)
	if err := s.Transition(ctx, "c_cancelled", []RunState{RunQueued}, RunCancelled, ""); err != nil {
		t.Fatal(err)
	}
	deploy("d_old", 10*time.Minute, 20*time.Minute, DeploySuccess)
	deploy("d_ok", 2*time.Hour+30*time.Minute, 2*time.Hour+31*time.Minute, DeploySuccess)
	deploy("d_failed", 6*time.Hour, 6*time.Hour+200*time.Second, DeployFailed)
	deploy("d_running", 7*time.Hour, 0, "")
	deploy("d_superseded", 0, 8*time.Hour, DeploySuperseded)

	ids := func(kind, repo string) []string {
		t.Helper()
		got, err := s.ListFinishedRuns(ctx, since, until, kind, repo)
		if err != nil {
			t.Fatalf("ListFinishedRuns(%q, %q): %v", kind, repo, err)
		}
		var out []string
		for _, r := range got {
			out = append(out, r.RunID)
		}
		return out
	}
	if got, want := ids("", ""), []string{"c_ok", "d_ok", "c_failed", "c_api", "d_failed"}; !slices.Equal(got, want) {
		t.Errorf("both kinds = %v, want %v (finished in window, by finish time)", got, want)
	}
	if got, want := ids(runstats.KindCheck, ""), []string{"c_ok", "c_failed", "c_api"}; !slices.Equal(got, want) {
		t.Errorf("checks = %v, want %v", got, want)
	}
	if got, want := ids(runstats.KindDeploy, ""), []string{"d_ok", "d_failed"}; !slices.Equal(got, want) {
		t.Errorf("deploys = %v, want %v", got, want)
	}
	if got, want := ids("", "acme/api"), []string{"c_api"}; !slices.Equal(got, want) {
		t.Errorf("repo acme/api = %v, want %v", got, want)
	}

	recs, err := s.ListFinishedRuns(ctx, since, until, "", "acme/web")
	if err != nil {
		t.Fatal(err)
	}
	want := []runstats.RunRecord{
		{RunID: "c_ok", Repo: "acme/web", Kind: "check", SHA: "sha-c_ok", Status: "success",
			StartedAt: at(2 * time.Hour), FinishedAt: at(2*time.Hour + 90*time.Second), DurationMS: 90_000},
		{RunID: "d_ok", Repo: "acme/web", Kind: "deploy", Env: "production", SHA: "sha-d_ok", Status: "success",
			StartedAt: at(2*time.Hour + 30*time.Minute), FinishedAt: at(2*time.Hour + 31*time.Minute), DurationMS: 60_000},
		{RunID: "c_failed", Repo: "acme/web", Kind: "check", SHA: "sha-c_failed", Status: "failed",
			StartedAt: at(3 * time.Hour), FinishedAt: at(3*time.Hour + 30*time.Second), DurationMS: 30_000},
		{RunID: "d_failed", Repo: "acme/web", Kind: "deploy", Env: "production", SHA: "sha-d_failed", Status: "failed",
			StartedAt: at(6 * time.Hour), FinishedAt: at(6*time.Hour + 200*time.Second), DurationMS: 200_000},
	}
	if len(recs) != len(want) {
		t.Fatalf("acme/web records = %+v, want %+v", recs, want)
	}
	for i := range want {
		g, w := recs[i], want[i]
		if g.RunID != w.RunID || g.Repo != w.Repo || g.Kind != w.Kind || g.Env != w.Env || g.SHA != w.SHA || g.Status != w.Status ||
			!g.StartedAt.Equal(w.StartedAt) || !g.FinishedAt.Equal(w.FinishedAt) || g.DurationMS != w.DurationMS {
			t.Errorf("record %d = %+v, want %+v", i, g, w)
		}
	}

	if _, err := s.ListFinishedRuns(ctx, since, until, "build", ""); err == nil {
		t.Error("unknown kind: want an error")
	}
}
