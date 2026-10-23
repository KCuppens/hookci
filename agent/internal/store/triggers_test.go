package store

import (
	"context"
	"errors"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/protocol"
)

func TestAcceptTriggerOnce(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	ok, err := s.AcceptTrigger(ctx, "t1", "run-1")
	if err != nil || !ok {
		t.Fatalf("first AcceptTrigger = %v, %v; want true", ok, err)
	}
	ok, err = s.AcceptTrigger(ctx, "t1", "run-2")
	if err != nil || ok {
		t.Fatalf("second AcceptTrigger = %v, %v; want false", ok, err)
	}

	items, err := s.Pending(ctx, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Kind != "accepted" {
		t.Fatalf("outbox = %+v, want one accepted frame", items)
	}
	var a protocol.Accepted
	if err := protocol.Unmarshal(items[0].Payload, &a); err != nil {
		t.Fatal(err)
	}
	if a.TriggerId != "t1" || a.RunId != "run-1" {
		t.Errorf("accepted = %+v, want t1/run-1", a)
	}
	got, err := s.ListTriggers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].RunID != "run-1" || got[0].State != TriggerAccepted || !got[0].CreatedAt.After(t0) {
		t.Errorf("triggers = %+v, want t1 accepted for run-1", got)
	}
}

func TestRejectTriggerAppendsFrame(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	if _, err := s.AcceptTrigger(ctx, "t1", "run-1"); err != nil {
		t.Fatal(err)
	}
	if err := s.RejectTrigger(ctx, "t1", "no_config"); err != nil {
		t.Fatal(err)
	}
	items, err := s.Pending(ctx, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[1].Kind != "rejected" {
		t.Fatalf("outbox = %+v, want accepted then rejected", items)
	}
	var r protocol.Rejected
	if err := protocol.Unmarshal(items[1].Payload, &r); err != nil {
		t.Fatal(err)
	}
	if r.TriggerId != "t1" || r.Reason != "no_config" {
		t.Errorf("rejected = %+v", r)
	}
	if err := s.RejectTrigger(ctx, "missing", "no_config"); !errors.Is(err, ErrNotFound) {
		t.Errorf("RejectTrigger(missing) = %v, want ErrNotFound", err)
	}
	if items, _ := s.Pending(ctx, 0, 0); len(items) != 2 {
		t.Errorf("a failed reject appended a frame: %d rows", len(items))
	}
}

func TestAnswerTrigger(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	for _, tc := range []struct {
		id, runID, reason string
	}{
		{id: "t1", runID: "run-1"},
		{id: "t2", reason: "deployments.prod: untrusted trigger cannot deploy"},
	} {
		ok, err := s.AnswerTrigger(ctx, tc.id, tc.runID, tc.reason)
		if err != nil || !ok {
			t.Fatalf("AnswerTrigger(%s) = %v, %v; want true", tc.id, ok, err)
		}
	}
	if ok, err := s.AnswerTrigger(ctx, "t1", "run-2", ""); err != nil || ok {
		t.Fatalf("second AnswerTrigger(t1) = %v, %v; want false", ok, err)
	}
	items, err := s.Pending(ctx, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].Kind != "accepted" || items[1].Kind != "rejected" {
		t.Fatalf("outbox = %+v, want accepted then rejected", items)
	}
	var a protocol.Accepted
	if err := protocol.Unmarshal(items[0].Payload, &a); err != nil || a.TriggerId != "t1" || a.RunId != "run-1" {
		t.Errorf("accepted = %+v, %v; want t1/run-1", a, err)
	}
	var r protocol.Rejected
	if err := protocol.Unmarshal(items[1].Payload, &r); err != nil || r.TriggerId != "t2" || r.Reason != "deployments.prod: untrusted trigger cannot deploy" {
		t.Errorf("rejected = %+v, %v", r, err)
	}
	// Neither is open, so startup recovery leaves both alone.
	if open, err := s.ListTriggers(ctx, TriggerAccepted, TriggerRunning); err != nil || len(open) != 0 {
		t.Errorf("open triggers = %+v, %v; want none", open, err)
	}
	for id, want := range map[string]bool{"t1": true, "t2": true, "t3": false} {
		if got, err := s.TriggerRecorded(ctx, id); err != nil || got != want {
			t.Errorf("TriggerRecorded(%s) = %v, %v; want %v", id, got, err, want)
		}
	}
}

func TestListTriggersByState(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	for _, id := range []string{"t1", "t2", "t3"} {
		if _, err := s.AcceptTrigger(ctx, id, "run-"+id); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.SetTriggerState(ctx, "t2", TriggerRunning); err != nil {
		t.Fatal(err)
	}
	if err := s.SetTriggerState(ctx, "t3", TriggerDone); err != nil {
		t.Fatal(err)
	}
	if err := s.SetTriggerState(ctx, "missing", TriggerDone); !errors.Is(err, ErrNotFound) {
		t.Errorf("SetTriggerState(missing) = %v, want ErrNotFound", err)
	}
	got, err := s.ListTriggers(ctx, TriggerAccepted, TriggerRunning)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != "t1" || got[1].ID != "t2" || got[1].State != TriggerRunning {
		t.Errorf("open triggers = %+v, want t1 accepted and t2 running", got)
	}
}

func TestDeployRunAccepted(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	for _, id := range []string{"run-ok", "run-bare", "run-rejected"} {
		if err := s.InsertDeployRun(ctx, testDeployRun(id, "prod-"+id, DeployQueued)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.AnswerTrigger(ctx, "trg-ok", "run-ok", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AnswerTrigger(ctx, "trg-rejected", "run-rejected", "untrusted trigger cannot deploy"); err != nil {
		t.Fatal(err)
	}
	// A checks trigger that finished names a checks run, not a deploy run.
	if _, err := s.AcceptTrigger(ctx, "trg-ci", "run-ci"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetTriggerState(ctx, "trg-ci", TriggerDone); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]bool{"run-ok": true, "run-bare": false, "run-rejected": false, "run-ci": false} {
		if got, err := s.DeployRunAccepted(ctx, id); err != nil || got != want {
			t.Errorf("DeployRunAccepted(%s) = %v, %v; want %v", id, got, err, want)
		}
	}
}
