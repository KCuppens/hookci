package detect

import (
	"bytes"
	"io/fs"
	"strings"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
)

func detectPython(fsys fs.FS) (*partial, error) {
	pyproject, err := readOptional(fsys, "pyproject.toml")
	if err != nil {
		return nil, err
	}
	hasRequirements := exists(fsys, "requirements.txt")
	if pyproject == nil && !hasRequirements {
		return nil, nil
	}

	p := &partial{ecosystem: "python"}
	var setup config.SetupStep
	var prefix string
	switch {
	case exists(fsys, "uv.lock"):
		setup = config.SetupStep{Run: "uv sync --frozen", Cache: &config.SetupStepCache{Key: []string{"uv.lock"}, Paths: []string{".venv"}}}
		prefix = "uv run "
		p.notes = append(p.notes, "python: uv (uv.lock)")
		p.sources = append(p.sources, "uv.lock")
	case pyproject != nil:
		setup = config.SetupStep{Run: "python -m venv .venv && .venv/bin/pip install -e .", Cache: &config.SetupStepCache{Key: []string{"pyproject.toml"}, Paths: []string{".venv"}}}
		prefix = ".venv/bin/"
		p.notes = append(p.notes, "python: pip into .venv (pyproject.toml)")
	default:
		setup = config.SetupStep{Run: "python -m venv .venv && .venv/bin/pip install -r requirements.txt", Cache: &config.SetupStepCache{Key: []string{"requirements.txt"}, Paths: []string{".venv"}}}
		prefix = ".venv/bin/"
		p.notes = append(p.notes, "python: pip into .venv (requirements.txt)")
	}
	p.setup = []config.SetupStep{setup}
	if pyproject != nil {
		p.sources = append(p.sources, "pyproject.toml")
	}
	if hasRequirements {
		p.sources = append(p.sources, "requirements.txt")
	}

	p.jobs = map[string]config.Job{}
	if src := ruffSource(fsys, pyproject); src != "" {
		p.jobs["ruff"] = config.Job{Run: prefix + "ruff check ."}
		if src != "pyproject.toml" {
			p.sources = append(p.sources, src)
		}
	}
	for _, dir := range []string{"tests", "test"} {
		if isDir(fsys, dir) {
			p.jobs["pytest"] = config.Job{Run: prefix + "pytest"}
			p.sources = append(p.sources, dir+"/")
			break
		}
	}
	return p, nil
}

// ruffSource returns the file that configures ruff: a [tool.ruff] table in
// pyproject.toml, ruff.toml or .ruff.toml. It returns "" when ruff is not
// configured.
func ruffSource(fsys fs.FS, pyproject []byte) string {
	for raw := range bytes.Lines(pyproject) {
		line := strings.TrimSpace(string(raw))
		if rest, ok := strings.CutPrefix(line, "[tool.ruff"); ok && (strings.HasPrefix(rest, "]") || strings.HasPrefix(rest, ".")) {
			return "pyproject.toml"
		}
	}
	for _, name := range []string{"ruff.toml", ".ruff.toml"} {
		if exists(fsys, name) {
			return name
		}
	}
	return ""
}
