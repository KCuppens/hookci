package isolationtest

import (
	"context"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
)

func TestFakeIsolation(t *testing.T) {
	fake := NewFake()
	fake.Responses["failing-job"] = isolation.Result{ExitCode: 1}

	ctx := context.Background()

	// Normal run returns default
	res, err := fake.Run(ctx, isolation.Spec{JobName: "passing-job"})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if res.ExitCode != 0 {
		t.Errorf("expected exit code 0, got %d", res.ExitCode)
	}

	// Configured run returns custom
	resFail, _ := fake.Run(ctx, isolation.Spec{JobName: "failing-job"})
	if resFail.ExitCode != 1 {
		t.Errorf("expected exit code 1, got %d", resFail.ExitCode)
	}

	// Verify Cleanup records runID
	_ = fake.Cleanup(ctx, "run123")
	if len(fake.Cleanups) != 1 || fake.Cleanups[0] != "run123" {
		t.Errorf("Cleanups = %v, want ['run123']", fake.Cleanups)
	}
}
