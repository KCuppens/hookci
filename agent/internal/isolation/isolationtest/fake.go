package isolationtest

import (
	"context"
	"sync"

	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
)

// Fake records executions and allows configuring mock results.
type Fake struct {
	mu            sync.Mutex
	Runs          []isolation.Spec
	Cleanups      []string
	Responses     map[string]isolation.Result
	DefaultResult isolation.Result
}

// NewFake constructs a Fake isolation backend.
func NewFake() *Fake {
	return &Fake{
		Responses: make(map[string]isolation.Result),
		DefaultResult: isolation.Result{
			ExitCode: 0,
		},
	}
}

// Run records spec and returns the matched or default result.
func (f *Fake) Run(_ context.Context, spec isolation.Spec) (isolation.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.Runs = append(f.Runs, spec)

	if resp, ok := f.Responses[spec.JobName]; ok {
		return resp, resp.Error
	}
	return f.DefaultResult, f.DefaultResult.Error
}

// Cleanup records the cleaned up run ID.
func (f *Fake) Cleanup(_ context.Context, runID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.Cleanups = append(f.Cleanups, runID)
	return nil
}
