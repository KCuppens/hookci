package detect

import (
	"io/fs"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
)

func detectGo(fsys fs.FS) (*partial, error) {
	if !exists(fsys, "go.mod") {
		return nil, nil
	}
	p := &partial{ecosystem: "go", sources: []string{"go.mod"}}
	key := "go.sum"
	if exists(fsys, key) {
		p.sources = append(p.sources, key)
	} else {
		key = "go.mod"
		p.notes = append(p.notes, "no go.sum, module cache keyed on go.mod")
	}
	p.setup = []config.SetupStep{{
		Run:   "go mod download",
		Cache: &config.SetupStepCache{Key: []string{key}, Paths: []string{"~/go/pkg/mod", "~/.cache/go-build"}},
	}}
	p.jobs = map[string]config.Job{
		"go-vet":  {Run: "go vet ./..."},
		"go-test": {Run: "go test ./..."},
	}
	return p, nil
}
