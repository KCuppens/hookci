package daemon

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

const budgetOverrideFile = "budget.json"

// Budget is what the capacity pool may admit: cores and memory in bytes,
// <= 0 for none.
type Budget struct {
	CPUs        float64
	MemoryBytes int64
}

// budgetOverride is the budget the hub set for this agent. A nil field
// leaves that part of the budget at the agent's own default.
type budgetOverride struct {
	CPUs        *float64 `json:"cpus"`
	MemoryBytes *int64   `json:"memory_bytes"`
}

// budget is def with the override laid over it.
func (o budgetOverride) budget(def Budget) Budget {
	if o.CPUs != nil {
		def.CPUs = *o.CPUs
	}
	if o.MemoryBytes != nil {
		def.MemoryBytes = *o.MemoryBytes
	}
	return def
}

// loadBudgetOverride reads the override saved in dir; a missing file is no
// override.
func loadBudgetOverride(dir string) (budgetOverride, error) {
	b, err := os.ReadFile(filepath.Join(dir, budgetOverrideFile))
	if errors.Is(err, fs.ErrNotExist) {
		return budgetOverride{}, nil
	}
	if err != nil {
		return budgetOverride{}, err
	}
	var o budgetOverride
	if err := json.Unmarshal(b, &o); err != nil {
		return budgetOverride{}, fmt.Errorf("parse %s: %w", budgetOverrideFile, err)
	}
	return o, nil
}

// saveBudgetOverride replaces the saved override atomically; an empty one
// removes the file.
func saveBudgetOverride(dir string, o budgetOverride) error {
	path := filepath.Join(dir, budgetOverrideFile)
	if o == (budgetOverride{}) {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	b, err := json.Marshal(o)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, budgetOverrideFile+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// HandleBudget implements hubclient.BudgetHandler: the hub's override is
// applied now and saved so it outlives a restart. Without one the agent's
// own flags and environment apply.
func (d *Daemon) HandleBudget(cpus *float64, memoryBytes *int64) {
	if d.o.Pool == nil {
		return
	}
	o := budgetOverride{CPUs: cpus, MemoryBytes: memoryBytes}
	if err := saveBudgetOverride(d.o.StateDir, o); err != nil {
		d.log.Warn("could not save the hub's budget override; it ends at restart", "err", err)
	}
	b := o.budget(d.o.BudgetDefault)
	d.o.Pool.SetBudget(b.CPUs, b.MemoryBytes)
	d.log.Info("budget set by hub", "cpus", cpus, "memory_bytes", memoryBytes)
}
