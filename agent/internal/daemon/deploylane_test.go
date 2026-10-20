package daemon

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/deploy/trigger"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// storingDeploys accepts every deploy trigger as a queued run, like the
// real intake.
type storingDeploys struct {
	st *store.Store
}

func (s *storingDeploys) Handle(ctx context.Context, t protocol.Trigger) (trigger.Decision, error) {
	runID := "run_" + t.TriggerId
	err := s.st.InsertDeployRun(ctx, store.DeployRun{
		RunID: runID, Repo: t.Repo, Env: *t.Env, SHA: t.Sha, Ref: t.Ref, Strategy: "script",
		Attempt: t.Attempt, State: store.DeployQueued, CreatedAt: time.Unix(1_700_000_000, 0),
	})
	return trigger.Decision{Accepted: true, RunID: runID}, err
}

// TestDeployRunQueuedAfterAcceptedFrame checks that the deploy lane asks the
// hub for a token for an accepted run only after the run's accepted frame:
// the hub refuses tokens for runs it does not know.
func TestDeployRunQueuedAfterAcceptedFrame(t *testing.T) {
	deploys := &storingDeploys{}
	h := newHarnessWith(t, &fakeSource{Head: map[string]string{ConfigFile: unitOnly}}, &fakeRunner{}, "https://hub.invalid", deploys)
	deploys.st = h.st

	h.send(h.deployTrigger("trg_1", "prod"))

	accepted, tokenReq := -1, -1
	deadline := time.Now().Add(10 * time.Second)
	for tokenReq < 0 && time.Now().Before(deadline) {
		items, err := h.st.Pending(h.ctx, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		for i, it := range items {
			var m map[string]any
			if err := json.Unmarshal(it.Payload, &m); err != nil {
				t.Fatal(err)
			}
			switch {
			case it.Kind == "accepted" && m["run_id"] == "run_trg_1":
				accepted = i
			case it.Kind == "token_request" && m["run_id"] == "run_trg_1":
				tokenReq = i
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	if tokenReq < 0 {
		t.Fatal("the deploy lane never asked for a token for run_trg_1")
	}
	if accepted < 0 || accepted > tokenReq {
		t.Errorf("accepted frame at %d, token request at %d; want the accepted frame first", accepted, tokenReq)
	}
}
