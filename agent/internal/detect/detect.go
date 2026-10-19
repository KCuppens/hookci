package detect

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"gopkg.in/yaml.v3"
)

// Ecosystem represents a detected programming language / project ecosystem.
type Ecosystem string

const (
	EcosystemGo       Ecosystem = "Go"
	EcosystemRust     Ecosystem = "Rust"
	EcosystemNodePnpm Ecosystem = "Node (pnpm+turbo)"
	EcosystemNodeNpm  Ecosystem = "Node (npm)"
	EcosystemNodeYarn Ecosystem = "Node (yarn)"
	EcosystemPython   Ecosystem = "Python"
	EcosystemUnknown  Ecosystem = "Unknown"
)

// ErrNoEcosystemDetected is returned when no supported project files are found.
var ErrNoEcosystemDetected = errors.New("no supported project ecosystem detected")

// Result contains the auto-detected ecosystem and generated ZeroCI config.
type Result struct {
	Ecosystem Ecosystem
	Config    *config.Config
}

// Detect inspects dir and returns the inferred ZeroCI configuration.
func Detect(dir string) (*Result, error) {
	detectors := []func(string) (*Result, error){
		detectNode,
		detectGo,
		detectRust,
		detectPython,
	}

	for _, d := range detectors {
		res, err := d(dir)
		if err != nil {
			return nil, err
		}
		if res != nil {
			if err := config.ValidateSemantics(res.Config); err != nil {
				return nil, fmt.Errorf("generated config validation failed: %w", err)
			}
			return res, nil
		}
	}

	return nil, ErrNoEcosystemDetected
}

// FormatYAML serializes the Config into standard YAML with header comment.
func FormatYAML(cfg *config.Config) ([]byte, error) {
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return nil, fmt.Errorf("marshal config to yaml: %w", err)
	}
	return data, nil
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// detectGo detects Go projects via go.mod.
func detectGo(dir string) (*Result, error) {
	goModPath := filepath.Join(dir, "go.mod")
	if !fileExists(goModPath) {
		return nil, nil
	}

	cfg := &config.Config{
		Version: 1,
		Setup:   []string{"go mod download"},
		Checks: config.ConfigChecks{
			"fmt": config.CheckJob{
				Run: "test -z \"$(gofmt -l .)\"",
			},
			"vet": config.CheckJob{
				Run: "go vet ./...",
			},
			"test": config.CheckJob{
				Run: "go test ./...",
			},
		},
		Caches: config.ConfigCaches{
			"go-mod": config.CacheConfig{
				Path: "go.sum",
				Key:  "go.sum",
			},
		},
	}

	return &Result{
		Ecosystem: EcosystemGo,
		Config:    cfg,
	}, nil
}

// detectRust detects Rust projects via Cargo.toml.
func detectRust(dir string) (*Result, error) {
	cargoPath := filepath.Join(dir, "Cargo.toml")
	if !fileExists(cargoPath) {
		return nil, nil
	}

	cfg := &config.Config{
		Version: 1,
		Checks: config.ConfigChecks{
			"fmt": config.CheckJob{
				Run: "cargo fmt --check",
			},
			"check": config.CheckJob{
				Run: "cargo check",
			},
			"test": config.CheckJob{
				Run: "cargo test",
			},
		},
		Caches: config.ConfigCaches{
			"target": config.CacheConfig{
				Path: "target",
				Key:  "Cargo.lock",
			},
		},
	}

	return &Result{
		Ecosystem: EcosystemRust,
		Config:    cfg,
	}, nil
}

type packageJSON struct {
	Scripts map[string]string `json:"scripts"`
}

type turboJSON struct {
	Tasks    map[string]any `json:"tasks"`
	Pipeline map[string]any `json:"pipeline"`
}

// detectNode detects Node/TypeScript projects (pnpm+turbo, npm, yarn).
func detectNode(dir string) (*Result, error) {
	pkgPath := filepath.Join(dir, "package.json")
	if !fileExists(pkgPath) {
		return nil, nil
	}

	data, err := os.ReadFile(pkgPath)
	if err != nil {
		return nil, fmt.Errorf("read package.json: %w", err)
	}

	var pkg packageJSON
	if err := json.Unmarshal(data, &pkg); err != nil {
		return nil, fmt.Errorf("parse package.json: %w", err)
	}

	hasTurbo := fileExists(filepath.Join(dir, "turbo.json"))
	hasPnpmLock := fileExists(filepath.Join(dir, "pnpm-lock.yaml"))
	hasYarnLock := fileExists(filepath.Join(dir, "yarn.lock"))

	if hasTurbo || hasPnpmLock {
		return detectPnpmTurbo(dir, pkg, hasTurbo)
	}

	if hasYarnLock {
		return detectYarn(pkg)
	}

	return detectNpm(dir, pkg)
}

func detectPnpmTurbo(dir string, pkg packageJSON, hasTurbo bool) (*Result, error) {
	cfg := &config.Config{
		Version: 1,
		Setup:   []string{"pnpm install --frozen-lockfile"},
		Checks:  make(config.ConfigChecks),
		Caches: config.ConfigCaches{
			"pnpm": config.CacheConfig{
				Path: ".pnpm-store",
				Key:  "pnpm-lock.yaml",
			},
		},
	}

	tasks := make(map[string]bool)
	if hasTurbo {
		cfg.Caches["turbo"] = config.CacheConfig{
			Path: ".turbo",
			Key:  "turbo.json",
		}
		turboData, err := os.ReadFile(filepath.Join(dir, "turbo.json"))
		if err == nil {
			var tj turboJSON
			_ = json.Unmarshal(turboData, &tj)
			for k := range tj.Tasks {
				tasks[k] = true
			}
			for k := range tj.Pipeline {
				tasks[k] = true
			}
		}
	}

	// Also check package.json scripts
	for k := range pkg.Scripts {
		tasks[k] = true
	}

	hasAny := false
	if tasks["lint"] {
		cfg.Checks["lint"] = config.CheckJob{Run: "pnpm turbo run lint"}
		hasAny = true
	}
	if tasks["typecheck"] {
		cfg.Checks["typecheck"] = config.CheckJob{Run: "pnpm turbo run typecheck"}
		hasAny = true
	}
	if tasks["test"] || tasks["unit"] {
		runCmd := "pnpm turbo run test"
		if !tasks["test"] && tasks["unit"] {
			runCmd = "pnpm turbo run unit"
		}
		cfg.Checks["unit"] = config.CheckJob{Run: runCmd}
		hasAny = true
	}
	if tasks["build"] && !hasAny {
		cfg.Checks["build"] = config.CheckJob{Run: "pnpm turbo run build"}
		hasAny = true
	}

	if !hasAny {
		cfg.Checks["test"] = config.CheckJob{Run: "pnpm test"}
	}

	return &Result{
		Ecosystem: EcosystemNodePnpm,
		Config:    cfg,
	}, nil
}

func detectYarn(pkg packageJSON) (*Result, error) {
	cfg := &config.Config{
		Version: 1,
		Setup:   []string{"yarn install --frozen-lockfile"},
		Checks:  make(config.ConfigChecks),
	}

	hasAny := false
	if _, ok := pkg.Scripts["lint"]; ok {
		cfg.Checks["lint"] = config.CheckJob{Run: "yarn lint"}
		hasAny = true
	}
	if _, ok := pkg.Scripts["typecheck"]; ok {
		cfg.Checks["typecheck"] = config.CheckJob{Run: "yarn typecheck"}
		hasAny = true
	}
	if _, ok := pkg.Scripts["test"]; ok {
		cfg.Checks["unit"] = config.CheckJob{Run: "yarn test"}
		hasAny = true
	} else if _, ok := pkg.Scripts["unit"]; ok {
		cfg.Checks["unit"] = config.CheckJob{Run: "yarn run unit"}
		hasAny = true
	}
	if _, ok := pkg.Scripts["build"]; ok && !hasAny {
		cfg.Checks["build"] = config.CheckJob{Run: "yarn build"}
		hasAny = true
	}

	if !hasAny {
		cfg.Checks["test"] = config.CheckJob{Run: "yarn test"}
	}

	return &Result{
		Ecosystem: EcosystemNodeYarn,
		Config:    cfg,
	}, nil
}

func detectNpm(dir string, pkg packageJSON) (*Result, error) {
	setupCmd := "npm install"
	if fileExists(filepath.Join(dir, "package-lock.json")) {
		setupCmd = "npm ci"
	}

	cfg := &config.Config{
		Version: 1,
		Setup:   []string{setupCmd},
		Checks:  make(config.ConfigChecks),
	}

	hasAny := false
	if _, ok := pkg.Scripts["lint"]; ok {
		cfg.Checks["lint"] = config.CheckJob{Run: "npm run lint"}
		hasAny = true
	}
	if _, ok := pkg.Scripts["typecheck"]; ok {
		cfg.Checks["typecheck"] = config.CheckJob{Run: "npm run typecheck"}
		hasAny = true
	}
	if _, ok := pkg.Scripts["test"]; ok {
		cfg.Checks["unit"] = config.CheckJob{Run: "npm test"}
		hasAny = true
	} else if _, ok := pkg.Scripts["unit"]; ok {
		cfg.Checks["unit"] = config.CheckJob{Run: "npm run unit"}
		hasAny = true
	}
	if _, ok := pkg.Scripts["build"]; ok && !hasAny {
		cfg.Checks["build"] = config.CheckJob{Run: "npm run build"}
		hasAny = true
	}

	if !hasAny {
		cfg.Checks["test"] = config.CheckJob{Run: "npm test"}
	}

	return &Result{
		Ecosystem: EcosystemNodeNpm,
		Config:    cfg,
	}, nil
}

// detectPython detects Python projects via pyproject.toml, requirements.txt, Pipfile, setup.py.
func detectPython(dir string) (*Result, error) {
	hasPyproject := fileExists(filepath.Join(dir, "pyproject.toml"))
	hasReqs := fileExists(filepath.Join(dir, "requirements.txt"))
	hasPipfile := fileExists(filepath.Join(dir, "Pipfile"))
	hasSetupPy := fileExists(filepath.Join(dir, "setup.py"))

	if !hasPyproject && !hasReqs && !hasPipfile && !hasSetupPy {
		return nil, nil
	}

	var setup []string
	if fileExists(filepath.Join(dir, "poetry.lock")) {
		setup = []string{"poetry install"}
	} else if hasPipfile {
		setup = []string{"pipenv install --dev"}
	} else if hasReqs {
		setup = []string{"pip install -r requirements.txt"}
	} else if hasSetupPy || hasPyproject {
		setup = []string{"pip install -e ."}
	}

	checks := make(config.ConfigChecks)

	var pyprojectContent string
	if hasPyproject {
		data, _ := os.ReadFile(filepath.Join(dir, "pyproject.toml"))
		pyprojectContent = string(data)
	}

	// Lint detection (ruff, flake8)
	if fileExists(filepath.Join(dir, "ruff.toml")) || fileExists(filepath.Join(dir, ".ruff.toml")) || strings.Contains(pyprojectContent, "[tool.ruff]") {
		checks["lint"] = config.CheckJob{Run: "ruff check ."}
	} else if fileExists(filepath.Join(dir, ".flake8")) {
		checks["lint"] = config.CheckJob{Run: "flake8"}
	}

	// Typecheck detection (mypy)
	if fileExists(filepath.Join(dir, "mypy.ini")) || strings.Contains(pyprojectContent, "[tool.mypy]") {
		checks["typecheck"] = config.CheckJob{Run: "mypy ."}
	}

	// Test detection
	if strings.Contains(pyprojectContent, "[tool.pytest") || fileExists(filepath.Join(dir, "pytest.ini")) || dirExists(filepath.Join(dir, "tests")) {
		checks["test"] = config.CheckJob{Run: "pytest"}
	} else {
		checks["test"] = config.CheckJob{Run: "python -m unittest"}
	}

	cfg := &config.Config{
		Version: 1,
		Setup:   setup,
		Checks:  checks,
	}

	return &Result{
		Ecosystem: EcosystemPython,
		Config:    cfg,
	}, nil
}
