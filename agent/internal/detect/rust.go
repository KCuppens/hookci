package detect

import (
	"io/fs"

	"github.com/KCuppens/hookci/agent/internal/config"
)

func detectRust(fsys fs.FS) (*partial, error) {
	if !exists(fsys, "Cargo.toml") {
		return nil, nil
	}
	p := &partial{ecosystem: "rust", sources: []string{"Cargo.toml"}}
	key := "Cargo.lock"
	if exists(fsys, key) {
		p.sources = append(p.sources, key)
	} else {
		key = "Cargo.toml"
		p.notes = append(p.notes, "no Cargo.lock, cargo cache keyed on Cargo.toml")
	}
	p.setup = []config.SetupStep{{
		Run:   "cargo fetch",
		Cache: &config.SetupStepCache{Key: []string{key}, Paths: []string{"~/.cargo/registry", "target"}},
	}}
	p.jobs = map[string]config.Job{
		"clippy":     {Run: "cargo clippy --all-targets -- -D warnings"},
		"cargo-test": {Run: "cargo test"},
	}
	return p, nil
}
