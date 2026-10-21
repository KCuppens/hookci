package detect

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/KCuppens/hookci/agent/internal/config"
)

// packageJSON holds the package.json fields detection reads. Unknown fields
// are ignored; workspaces and engines are decoded leniently because their
// shape varies between tools and eras.
type packageJSON struct {
	Scripts        map[string]string `json:"scripts"`
	PackageManager string            `json:"packageManager"`
	Workspaces     json.RawMessage   `json:"workspaces"`
	Engines        json.RawMessage   `json:"engines"`
}

// workspaceGlobs returns the workspaces field as a list of globs, accepting
// both the array form and yarn's {"packages": [...]} form.
func (p packageJSON) workspaceGlobs() []string {
	var list []string
	if json.Unmarshal(p.Workspaces, &list) == nil {
		return list
	}
	var obj struct {
		Packages []string `json:"packages"`
	}
	if json.Unmarshal(p.Workspaces, &obj) == nil {
		return obj.Packages
	}
	return nil
}

// engineNode returns engines.node, or "" when absent or not a string.
func (p packageJSON) engineNode() string {
	var engines map[string]any
	if json.Unmarshal(p.Engines, &engines) != nil {
		return ""
	}
	node, _ := engines["node"].(string)
	return strings.TrimSpace(node)
}

// packageManager describes how to install dependencies and run tools.
type packageManager struct {
	// Name is pnpm, npm, yarn or bun.
	Name string
	// Lock is the lockfile that backs a reproducible install, "" when none.
	Lock string
	// Install is the setup command.
	Install string
	// Exec runs a locally installed binary (pnpm exec, npx --no-install, ...).
	Exec string
}

// lockfiles in priority order when no packageManager field decides.
var lockfiles = []struct{ name, pm string }{
	{"pnpm-lock.yaml", "pnpm"},
	{"bun.lockb", "bun"},
	{"bun.lock", "bun"},
	{"yarn.lock", "yarn"},
	{"package-lock.json", "npm"},
}

var execForms = map[string]string{
	"pnpm": "pnpm exec",
	"npm":  "npx --no-install",
	"yarn": "yarn",
	"bun":  "bunx",
}

// detectPackageManager picks the package manager: the packageManager field
// wins, then the lockfile priority, then npm. The bool reports whether a
// lockfile backs the install; without one the install is not reproducible.
func detectPackageManager(fsys fs.FS, pkg packageJSON) (packageManager, bool) {
	name := ""
	if field, _, _ := strings.Cut(strings.TrimSpace(pkg.PackageManager), "@"); execForms[field] != "" {
		name = field
	}
	lock := ""
	for _, l := range lockfiles {
		if (name == "" || name == l.pm) && exists(fsys, l.name) {
			name, lock = l.pm, l.name
			break
		}
	}
	if name == "" {
		name = "npm"
	}
	pm := packageManager{Name: name, Lock: lock, Exec: execForms[name], Install: name + " install"}
	if lock == "" {
		return pm, false
	}
	switch name {
	case "pnpm":
		pm.Install = "pnpm install --frozen-lockfile"
	case "npm":
		pm.Install = "npm ci"
	case "yarn":
		if exists(fsys, ".yarnrc.yml") {
			pm.Install = "yarn install --immutable"
		} else {
			pm.Install = "yarn install --frozen-lockfile"
		}
	case "bun":
		pm.Install = "bun install --frozen-lockfile"
	}
	return pm, true
}

// npmPlaceholderTest is the test script npm init writes.
const npmPlaceholderTest = `echo "Error: no test specified" && exit 1`

// turboJSON holds the turbo.json fields detection reads: tasks (v2) or
// pipeline (v1).
type turboJSON struct {
	Tasks    map[string]turboTask `json:"tasks"`
	Pipeline map[string]turboTask `json:"pipeline"`
}

type turboTask struct {
	Cache      *bool `json:"cache"`
	Persistent bool  `json:"persistent"`
}

// devServer reports a task that never finishes (cache: false, persistent: true).
func (t turboTask) devServer() bool {
	return t.Cache != nil && !*t.Cache && t.Persistent
}

func detectNode(fsys fs.FS) (*partial, error) {
	data, err := readOptional(fsys, "package.json")
	if err != nil || data == nil {
		return nil, err
	}
	var pkg packageJSON
	if err := json.Unmarshal(data, &pkg); err != nil {
		return nil, fmt.Errorf("package.json: %w", err)
	}

	p := &partial{ecosystem: "node", sources: []string{"package.json"}}
	pm, locked := detectPackageManager(fsys, pkg)
	switch {
	case pm.Lock != "":
		p.notes = append(p.notes, fmt.Sprintf("package manager: %s (%s)", pm.Name, pm.Lock))
		p.sources = append(p.sources, pm.Lock)
	case pkg.PackageManager != "":
		p.notes = append(p.notes, fmt.Sprintf("package manager: %s (packageManager field)", pm.Name))
	default:
		p.notes = append(p.notes, "package manager: npm (default)")
	}
	if !locked {
		p.notes = append(p.notes, "no lockfile, install is not reproducible")
	}
	if pm.Name == "yarn" && exists(fsys, ".yarnrc.yml") {
		p.sources = append(p.sources, ".yarnrc.yml")
	}

	globs := pkg.workspaceGlobs()
	ws, err := readOptional(fsys, "pnpm-workspace.yaml")
	if err != nil {
		return nil, err
	}
	if ws != nil {
		var doc struct {
			Packages []string `yaml:"packages"`
		}
		if err := yaml.Unmarshal(ws, &doc); err != nil {
			return nil, fmt.Errorf("pnpm-workspace.yaml: %w", err)
		}
		globs = doc.Packages
		p.sources = append(p.sources, "pnpm-workspace.yaml")
	}

	key := pm.Lock
	if key == "" {
		key = "package.json"
	}
	p.setup = []config.SetupStep{{
		Run:   pm.Install,
		Cache: &config.SetupStepCache{Key: []string{key}, Paths: nodeModulesPaths(globs)},
	}}

	if note, src := nodeVersionNote(fsys, pkg); note != "" {
		p.notes = append(p.notes, note)
		if src != "" {
			p.sources = append(p.sources, src)
		}
	}

	turbo, err := readOptional(fsys, "turbo.json")
	if err != nil {
		return nil, err
	}
	if turbo != nil {
		var tj turboJSON
		if err := json.Unmarshal(turbo, &tj); err != nil {
			return nil, fmt.Errorf("turbo.json: %w", err)
		}
		tasks := tj.Tasks
		if tasks == nil {
			tasks = tj.Pipeline
		}
		present := map[string]bool{}
		for name, task := range tasks {
			present[name] = !task.devServer()
		}
		p.jobs = nodeJobs(present, func(task string) string {
			return fmt.Sprintf("sh -c '%s turbo run %s ${HOOKCI_BASE_SHA:+--filter=...[$HOOKCI_BASE_SHA]}'", pm.Exec, task)
		})
		p.notes = append(p.notes, fmt.Sprintf("turbo runs as %s turbo, so turbo must be a devDependency", pm.Exec))
		p.sources = append(p.sources, "turbo.json")
		return p, nil
	}

	present := map[string]bool{}
	for name, script := range pkg.Scripts {
		script = strings.TrimSpace(script)
		present[name] = script != "" && !(name == "test" && strings.Contains(script, npmPlaceholderTest))
	}
	p.jobs = nodeJobs(present, func(script string) string {
		return pm.Name + " run " + script
	})
	return p, nil
}

// nodeJobs maps script or turbo task names to jobs: lint, typecheck (from
// typecheck, type-check or tsc, first match), and unit (test:unit) or test.
func nodeJobs(present map[string]bool, run func(string) string) map[string]config.Job {
	jobs := map[string]config.Job{}
	eslint, tsc := config.JobAnnotateEslint, config.JobAnnotateTsc
	if present["lint"] {
		jobs["lint"] = config.Job{Run: run("lint"), Annotate: &eslint}
	}
	for _, name := range []string{"typecheck", "type-check", "tsc"} {
		if present[name] {
			jobs["typecheck"] = config.Job{Run: run(name), Annotate: &tsc}
			break
		}
	}
	switch {
	case present["test:unit"]:
		jobs["unit"] = config.Job{Run: run("test:unit")}
	case present["test"]:
		jobs["test"] = config.Job{Run: run("test")}
	}
	return jobs
}

// nodeModulesPaths returns node_modules plus <glob>/node_modules for every
// workspace glob, kept literal and sorted. Negated globs are skipped.
func nodeModulesPaths(globs []string) []string {
	paths := []string{"node_modules"}
	for _, g := range globs {
		g = strings.TrimPrefix(strings.TrimSpace(g), "./")
		g = strings.TrimRight(g, "/")
		if g == "" || g == "." || strings.HasPrefix(g, "!") {
			continue
		}
		paths = append(paths, path.Join(g, "node_modules"))
	}
	return uniqueSorted(paths)
}

// nodeVersionNote reports the requested Node version from .nvmrc,
// .node-version, engines.node or the packageManager field, first match. The
// version is informational only: no toolchain is installed.
func nodeVersionNote(fsys fs.FS, pkg packageJSON) (note, source string) {
	for _, name := range []string{".nvmrc", ".node-version"} {
		data, err := fs.ReadFile(fsys, name)
		if err != nil {
			continue
		}
		if v := firstLine(data); v != "" {
			return fmt.Sprintf("node %s (from %s), not installed by hookci", v, name), name
		}
	}
	if v := pkg.engineNode(); v != "" {
		return fmt.Sprintf("node %s (from engines.node), not installed by hookci", v), ""
	}
	if v, _, _ := strings.Cut(strings.TrimSpace(pkg.PackageManager), "+"); v != "" {
		return fmt.Sprintf("%s (from packageManager), not installed by hookci", v), ""
	}
	return "", ""
}

func firstLine(data []byte) string {
	line, _, _ := bytes.Cut(data, []byte("\n"))
	return strings.TrimSpace(string(line))
}
