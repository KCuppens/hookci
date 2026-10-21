package isolationtest

import (
	"context"
	"slices"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/isolation"
)

var _ isolation.Isolation = (*Fake)(nil)

func TestFakeIsolation(t *testing.T) {
	fake := NewFake()
	fake.Responses["failing-job"] = isolation.Result{ExitCode: 1}
	ctx := context.Background()

	res, err := fake.Run(ctx, isolation.Spec{Job: "passing-job"})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if res.ExitCode != 0 {
		t.Errorf("expected exit code 0, got %d", res.ExitCode)
	}
	if resFail, _ := fake.Run(ctx, isolation.Spec{Job: "failing-job"}); resFail.ExitCode != 1 {
		t.Errorf("expected exit code 1, got %d", resFail.ExitCode)
	}

	fake.Units = []isolation.Unit{
		{Name: isolation.UnitName("run1", "lint"), Active: "active"},
		{Name: isolation.UnitName("run2", "lint"), Active: "active"},
	}
	units, _ := fake.ListUnits(ctx, "hookci-run-run1-")
	if len(units) != 1 || units[0].Name != "hookci-run-run1-lint" {
		t.Fatalf("ListUnits = %v, want only run1's unit", units)
	}
	_ = fake.Stop(ctx, units[0].Name)
	if !slices.Equal(fake.Stops, []string{"hookci-run-run1-lint"}) {
		t.Errorf("Stops = %v", fake.Stops)
	}
	if left, _ := fake.ListUnits(ctx, "hookci-run-run1-"); len(left) != 0 {
		t.Errorf("stopped unit still listed: %v", left)
	}
}
