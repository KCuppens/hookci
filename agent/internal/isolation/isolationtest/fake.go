// Package isolationtest provides an in-memory isolation.Isolation for tests.
package isolationtest

import (
	"context"
	"slices"
	"strings"
	"sync"

	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
)

// Fake records executions and allows configuring mock results. Units are
// the live units ListUnits reports; Stop records the unit and removes it.
type Fake struct {
	mu            sync.Mutex
	Runs          []isolation.Spec
	Responses     map[string]isolation.Result // keyed by Spec.Job
	DefaultResult isolation.Result
	Units         []isolation.Unit
	Stops         []string
}

// NewFake constructs a Fake isolation backend.
func NewFake() *Fake {
	return &Fake{Responses: make(map[string]isolation.Result)}
}

// Name reports "fake".
func (f *Fake) Name() string { return "fake" }

// Run records spec and returns the matched or default result.
func (f *Fake) Run(_ context.Context, spec isolation.Spec) (isolation.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.Runs = append(f.Runs, spec)
	if resp, ok := f.Responses[spec.Job]; ok {
		return resp, nil
	}
	return f.DefaultResult, nil
}

// Stop records unit and drops it from Units.
func (f *Fake) Stop(_ context.Context, unit string) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.Stops = append(f.Stops, unit)
	f.Units = slices.DeleteFunc(f.Units, func(u isolation.Unit) bool { return u.Name == unit })
	return nil
}

// ListUnits returns the configured Units whose name starts with prefix.
func (f *Fake) ListUnits(_ context.Context, prefix string) ([]isolation.Unit, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	var units []isolation.Unit
	for _, u := range f.Units {
		if strings.HasPrefix(u.Name, prefix) {
			units = append(units, u)
		}
	}
	return units, nil
}
