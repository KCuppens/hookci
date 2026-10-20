package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
)

var t0 = time.Date(2026, 1, 2, 3, 4, 5, 6_000_000, time.UTC)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	var (
		mu  sync.Mutex
		now = t0
	)
	clock := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		now = now.Add(time.Millisecond)
		return now
	}
	s, err := Open(filepath.Join(t.TempDir(), "state", "agent.db"), WithClock(clock))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func testRun(id string) Run {
	return Run{
		ID: id, Repo: "acme/web", SHA: "sha-" + id, Ref: "refs/heads/main", Event: "push",
		Kind: "check", TrustDomain: "trusted:acme/web", TriggerID: "trig-" + id,
	}
}

func mustCreateRun(t *testing.T, s *Store, r Run, jobs ...Job) {
	t.Helper()
	if err := s.CreateRun(context.Background(), r, jobs); err != nil {
		t.Fatalf("CreateRun(%s): %v", r.ID, err)
	}
}

func outboxCount(t *testing.T, s *Store) int {
	t.Helper()
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM outbox`).Scan(&n); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	return n
}

func clearOutbox(t *testing.T, s *Store) {
	t.Helper()
	if _, err := s.db.Exec(`DELETE FROM outbox`); err != nil {
		t.Fatalf("clear outbox: %v", err)
	}
}

func lastEvent(t *testing.T, s *Store) (int64, protocol.Event) {
	t.Helper()
	items, err := s.Pending(context.Background(), 0, 0)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if len(items) == 0 {
		t.Fatal("outbox is empty")
	}
	it := items[len(items)-1]
	if it.Kind != KindEvent {
		t.Fatalf("last outbox kind = %q, want %q", it.Kind, KindEvent)
	}
	var ev protocol.Event
	if err := protocol.Unmarshal(it.Payload, &ev); err != nil {
		t.Fatalf("Unmarshal outbox payload: %v", err)
	}
	return it.Seq, ev
}

func TestOpenCreatesWAL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "agent.db")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	var mode string
	if err := s.db.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil {
		t.Fatalf("journal_mode: %v", err)
	}
	if mode != "wal" {
		t.Errorf("journal_mode = %q, want wal", mode)
	}
	var fk int
	if err := s.db.QueryRow(`PRAGMA foreign_keys`).Scan(&fk); err != nil || fk != 1 {
		t.Errorf("foreign_keys = %d (%v), want 1", fk, err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat db: %v", err)
	}
	if got := fi.Mode().Perm(); got != 0o600 {
		t.Errorf("db mode = %o, want 600", got)
	}
	di, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatalf("stat dir: %v", err)
	}
	if got := di.Mode().Perm(); got != 0o700 {
		t.Errorf("dir mode = %o, want 700", got)
	}

	s, err = Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s.Close()
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM schema_migrations`).Scan(&n); err != nil {
		t.Fatalf("count schema_migrations: %v", err)
	}
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		t.Fatalf("read embedded migrations: %v", err)
	}
	if n != len(entries) {
		t.Errorf("schema_migrations rows = %d, want %d", n, len(entries))
	}
}

func TestCreateRunEmitsQueuedAndPlanned(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	pr := 7
	r := testRun("r1")
	r.Event, r.PR, r.Env = "pull_request", &pr, "staging"
	quiet := protocol.JobPlannedSlackNotifyQuiet
	r.Slack = &protocol.JobPlannedSlack{Channel: "#deploys", Notify: &quiet}
	mustCreateRun(t, s, r, Job{Name: "lint"}, Job{Name: "test", Needs: []string{"lint"}})

	got, err := s.GetRun(ctx, "r1")
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if got.State != RunQueued || got.Attempt != 1 || got.PR == nil || *got.PR != 7 || got.RetryOf != nil {
		t.Errorf("GetRun = %+v, want queued attempt 1 pr 7 no retry_of", got)
	}
	if !got.CreatedAt.After(t0) || got.CreatedAt.After(t0.Add(time.Second)) {
		t.Errorf("CreatedAt = %v, want a tick of the injected clock after %v", got.CreatedAt, t0)
	}

	items, err := s.Pending(ctx, 0, 0)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if len(items) != 2 || items[0].Kind != KindEvent || items[1].Kind != KindJobPlanned {
		t.Fatalf("outbox = %+v, want [event job_planned]", items)
	}
	var ev protocol.Event
	if err := protocol.Unmarshal(items[0].Payload, &ev); err != nil {
		t.Fatalf("Unmarshal event: %v", err)
	}
	if ev.RunId != "r1" || ev.State != protocol.EventState(RunQueued) || int64(ev.AgentSeq) != items[0].Seq {
		t.Errorf("event = %+v, want queued r1 with agent_seq %d", ev, items[0].Seq)
	}
	var plan protocol.JobPlanned
	if err := protocol.Unmarshal(items[1].Payload, &plan); err != nil {
		t.Fatalf("Unmarshal job_planned: %v", err)
	}
	if plan.RunId != "r1" || plan.Env == nil || *plan.Env != "staging" || len(plan.Jobs) != 2 ||
		plan.Jobs[0].Name != "lint" || len(plan.Jobs[0].Needs) != 0 ||
		plan.Jobs[1].Name != "test" || len(plan.Jobs[1].Needs) != 1 || plan.Jobs[1].Needs[0] != "lint" {
		t.Errorf("job_planned = %+v", plan)
	}
	if plan.Slack == nil || plan.Slack.Channel != "#deploys" || plan.Slack.Notify == nil || *plan.Slack.Notify != quiet || plan.Slack.Alert != nil {
		t.Errorf("job_planned slack = %+v, want #deploys quiet without alert", plan.Slack)
	}
}

func TestCreateRunUniqueAttempt(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	mustCreateRun(t, s, testRun("r1"), Job{Name: "lint"}, Job{Name: "test", Needs: []string{"lint"}})

	dup := testRun("r2")
	dup.SHA = "sha-r1"
	if err := s.CreateRun(ctx, dup, nil); err == nil {
		t.Fatal("CreateRun with duplicate (repo, sha, event, env, attempt) succeeded")
	}
	if _, err := s.GetRun(ctx, "r2"); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetRun(r2) err = %v, want ErrNotFound", err)
	}

	if _, err := s.CreateRetry(ctx, "r1"); !errors.Is(err, ErrInvalidTransition) {
		t.Errorf("CreateRetry of queued run err = %v, want ErrInvalidTransition", err)
	}
	if err := s.Transition(ctx, "r1", []RunState{RunQueued}, RunRunning, ""); err != nil {
		t.Fatal(err)
	}
	if err := s.TransitionJob(ctx, "r1", "lint", []JobState{JobQueued}, JobRunning, JobUpdate{}); err != nil {
		t.Fatal(err)
	}
	if err := s.TransitionJob(ctx, "r1", "lint", []JobState{JobRunning}, JobFailed, JobUpdate{}); err != nil {
		t.Fatal(err)
	}
	if err := s.Transition(ctx, "r1", []RunState{RunRunning}, RunFailed, "lint failed"); err != nil {
		t.Fatal(err)
	}

	retry, err := s.CreateRetry(ctx, "r1")
	if err != nil {
		t.Fatalf("CreateRetry: %v", err)
	}
	if retry.ID == "r1" || retry.Attempt != 2 || retry.RetryOf == nil || *retry.RetryOf != "r1" ||
		retry.State != RunQueued || retry.SHA != "sha-r1" || retry.Reason != "" || retry.StartedAt != nil {
		t.Errorf("retry = %+v, want new queued attempt 2 of r1", retry)
	}
	stored, err := s.GetRun(ctx, retry.ID)
	if err != nil || stored.Attempt != 2 {
		t.Errorf("GetRun(retry) = %+v, %v", stored, err)
	}
	jobs, err := s.Jobs(ctx, retry.ID)
	if err != nil {
		t.Fatalf("Jobs: %v", err)
	}
	if len(jobs) != 2 || jobs[0].Name != "lint" || jobs[1].Name != "test" || len(jobs[1].Needs) != 1 {
		t.Fatalf("retry jobs = %+v, want lint, test(needs lint)", jobs)
	}
	for _, j := range jobs {
		if j.State != JobQueued || j.StartedAt != nil || j.FinishedAt != nil {
			t.Errorf("retry job %s = %+v, want fresh queued", j.Name, j)
		}
	}
}

// Retrying the same terminal run twice must not collide on
// UNIQUE (repo, sha, event, env, attempt).
func TestCreateRetryTwice(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	mustCreateRun(t, s, testRun("r1"), Job{Name: "lint"})
	if err := s.Transition(ctx, "r1", []RunState{RunQueued}, RunCancelled, ""); err != nil {
		t.Fatal(err)
	}
	var attempts []int
	for range 2 {
		retry, err := s.CreateRetry(ctx, "r1")
		if err != nil {
			t.Fatalf("CreateRetry: %v", err)
		}
		if retry.Event != "push" {
			t.Errorf("retry event = %q, want the original push", retry.Event)
		}
		attempts = append(attempts, retry.Attempt)
	}
	if !slices.Equal(attempts, []int{2, 3}) {
		t.Fatalf("attempts = %v, want [2 3]", attempts)
	}
}

func TestInterruptRun(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	mustCreateRun(t, s, testRun("r1"), Job{Name: "lint"}, Job{Name: "test"}, Job{Name: "build"})
	if err := s.Transition(ctx, "r1", []RunState{RunQueued}, RunRunning, ""); err != nil {
		t.Fatal(err)
	}
	for _, step := range []struct {
		job      string
		from, to JobState
	}{{"lint", JobQueued, JobRunning}, {"lint", JobRunning, JobSuccess}, {"test", JobQueued, JobRunning}} {
		if err := s.TransitionJob(ctx, "r1", step.job, []JobState{step.from}, step.to, JobUpdate{}); err != nil {
			t.Fatal(err)
		}
	}

	retry, err := s.InterruptRun(ctx, "r1", "agent restarted", true)
	if err != nil {
		t.Fatalf("InterruptRun: %v", err)
	}
	run, err := s.GetRun(ctx, "r1")
	if err != nil || run.State != RunInterrupted || run.Reason != "agent restarted" {
		t.Fatalf("run = %+v, %v; want interrupted with the reason", run, err)
	}
	jobs, err := s.Jobs(ctx, "r1")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]JobState{"lint": JobSuccess, "test": JobInterrupted, "build": JobInterrupted}
	for _, j := range jobs {
		if j.State != want[j.Name] {
			t.Errorf("job %s = %s, want %s", j.Name, j.State, want[j.Name])
		}
	}
	if retry.Attempt != 2 || retry.RetryOf == nil || *retry.RetryOf != "r1" || retry.State != RunQueued {
		t.Errorf("retry = %+v, want queued attempt 2 of r1", retry)
	}

	noRetry, err := s.InterruptRun(ctx, "r1", "again", false)
	if !errors.Is(err, ErrStateMismatch) || noRetry.ID != "" {
		t.Errorf("InterruptRun of an interrupted run = %+v, %v; want ErrStateMismatch", noRetry, err)
	}
}

// A failed run transition rolls back the job transitions made before it.
func TestInterruptRunAtomic(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	mustCreateRun(t, s, testRun("r1"), Job{Name: "lint"})
	clearOutbox(t, s)

	if _, err := s.InterruptRun(ctx, "r1", "agent restarted", true); !errors.Is(err, ErrStateMismatch) {
		t.Fatalf("InterruptRun of a queued run err = %v, want ErrStateMismatch", err)
	}
	jobs, err := s.Jobs(ctx, "r1")
	if err != nil || len(jobs) != 1 || jobs[0].State != JobQueued {
		t.Fatalf("jobs = %+v, %v; want lint still queued", jobs, err)
	}
	if n := outboxCount(t, s); n != 0 {
		t.Errorf("outbox rows = %d, want 0", n)
	}
	runs, err := s.ListRuns(ctx, RunFilter{})
	if err != nil || len(runs) != 1 {
		t.Errorf("runs = %d, %v; want only r1", len(runs), err)
	}
}

func TestTransitionWritesOutboxAtomically(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	mustCreateRun(t, s, testRun("r1"))
	clearOutbox(t, s)

	if err := s.Transition(ctx, "r1", []RunState{RunQueued}, RunRunning, ""); err != nil {
		t.Fatalf("Transition: %v", err)
	}
	if n := outboxCount(t, s); n != 1 {
		t.Fatalf("outbox rows = %d, want 1", n)
	}
	seq, ev := lastEvent(t, s)
	if int64(ev.AgentSeq) != seq || ev.State != protocol.EventState(RunRunning) || ev.RunId != "r1" || ev.Reason != nil {
		t.Errorf("event = %+v, want running r1 with agent_seq %d and no reason", ev, seq)
	}
	run, err := s.GetRun(ctx, "r1")
	if err != nil || run.StartedAt == nil || run.FinishedAt != nil {
		t.Errorf("after running: %+v, %v; want started_at set, finished_at nil", run, err)
	}

	t.Run("failed outbox insert rolls back state", func(t *testing.T) {
		clearOutbox(t, s)
		if _, err := s.db.Exec(`CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'forced'); END`); err != nil {
			t.Fatalf("create trigger: %v", err)
		}
		err := s.Transition(ctx, "r1", []RunState{RunRunning}, RunFailed, "boom")
		if _, dropErr := s.db.Exec(`DROP TRIGGER fail_outbox`); dropErr != nil {
			t.Fatalf("drop trigger: %v", dropErr)
		}
		if err == nil || !strings.Contains(err.Error(), "forced") {
			t.Fatalf("Transition err = %v, want forced failure", err)
		}
		run, err := s.GetRun(ctx, "r1")
		if err != nil {
			t.Fatal(err)
		}
		if run.State != RunRunning || run.Reason != "" || run.FinishedAt != nil {
			t.Errorf("run after failed transition = %+v, want unchanged running", run)
		}
		if n := outboxCount(t, s); n != 0 {
			t.Errorf("outbox rows = %d, want 0", n)
		}
	})

	t.Run("reason is stored and sent", func(t *testing.T) {
		clearOutbox(t, s)
		if err := s.Transition(ctx, "r1", []RunState{RunRunning}, RunFailed, "lint failed"); err != nil {
			t.Fatalf("Transition: %v", err)
		}
		_, ev := lastEvent(t, s)
		if ev.Reason == nil || *ev.Reason != "lint failed" || ev.State != protocol.EventState(RunFailed) {
			t.Errorf("event = %+v, want failed with reason", ev)
		}
		run, err := s.GetRun(ctx, "r1")
		if err != nil || run.Reason != "lint failed" || run.FinishedAt == nil {
			t.Errorf("run = %+v, %v; want reason and finished_at", run, err)
		}
	})
}

func TestConcurrentTransitions(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	const n = 50
	for i := range n {
		mustCreateRun(t, s, testRun(fmt.Sprintf("r%02d", i)))
	}

	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := fmt.Sprintf("r%02d", i)
			if err := s.Transition(ctx, id, []RunState{RunQueued}, RunRunning, ""); err != nil {
				errs <- err
				return
			}
			if err := s.Transition(ctx, id, []RunState{RunRunning}, RunSuccess, ""); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent transition: %v", err)
	}

	runs, err := s.ListRuns(ctx, RunFilter{States: []RunState{RunSuccess}})
	if err != nil {
		t.Fatalf("ListRuns: %v", err)
	}
	if len(runs) != n {
		t.Errorf("success runs = %d, want %d", len(runs), n)
	}
}

func TestListRunsFilter(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	mustCreateRun(t, s, testRun("a"))
	mustCreateRun(t, s, testRun("b"))
	other := testRun("c")
	other.Repo = "acme/api"
	mustCreateRun(t, s, other)
	if err := s.Transition(ctx, "b", []RunState{RunQueued}, RunRunning, ""); err != nil {
		t.Fatal(err)
	}

	ids := func(runs []Run) string {
		var out []string
		for _, r := range runs {
			out = append(out, r.ID)
		}
		return strings.Join(out, ",")
	}
	cases := []struct {
		name string
		f    RunFilter
		want string
	}{
		{"all newest first", RunFilter{}, "c,b,a"},
		{"repo", RunFilter{Repo: "acme/web"}, "b,a"},
		{"states", RunFilter{States: []RunState{RunQueued}}, "c,a"},
		{"repo and states", RunFilter{Repo: "acme/web", States: []RunState{RunQueued, RunRunning}}, "b,a"},
		{"limit", RunFilter{Limit: 1}, "c"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			runs, err := s.ListRuns(ctx, tc.f)
			if err != nil {
				t.Fatalf("ListRuns: %v", err)
			}
			if got := ids(runs); got != tc.want {
				t.Errorf("ListRuns = %s, want %s", got, tc.want)
			}
		})
	}
}
