package detect

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
)

func TestDetectGo(t *testing.T) {
	dir := t.TempDir()
	goMod := `module example.com/myapp

go 1.24
`
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte(goMod), 0o600); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	res, err := Detect(dir)
	if err != nil {
		t.Fatalf("Detect failed: %v", err)
	}
	if res.Ecosystem != EcosystemGo {
		t.Errorf("expected %s, got %s", EcosystemGo, res.Ecosystem)
	}
	if res.Config.Version != 1 {
		t.Errorf("expected version 1, got %d", res.Config.Version)
	}
	if s := res.Config.Checks.Setup; len(s) != 1 || s[0].Run != "go mod download" {
		t.Errorf("unexpected setup: %+v", s)
	}
	expectedJobs := []string{"fmt", "vet", "test"}
	for _, job := range expectedJobs {
		if _, ok := res.Config.Checks.Jobs[job]; !ok {
			t.Errorf("expected check job %q not found", job)
		}
	}
	if err := config.ValidateSemantics(res.Config); err != nil {
		t.Errorf("ValidateSemantics failed on generated config: %v", err)
	}
}

func TestDetectRust(t *testing.T) {
	dir := t.TempDir()
	cargoToml := `[package]
name = "myapp"
version = "0.1.0"
edition = "2021"
`
	if err := os.WriteFile(filepath.Join(dir, "Cargo.toml"), []byte(cargoToml), 0o600); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	res, err := Detect(dir)
	if err != nil {
		t.Fatalf("Detect failed: %v", err)
	}
	if res.Ecosystem != EcosystemRust {
		t.Errorf("expected %s, got %s", EcosystemRust, res.Ecosystem)
	}
	expectedJobs := []string{"fmt", "check", "test"}
	for _, job := range expectedJobs {
		if _, ok := res.Config.Checks.Jobs[job]; !ok {
			t.Errorf("expected check job %q not found", job)
		}
	}
	if err := config.ValidateSemantics(res.Config); err != nil {
		t.Errorf("ValidateSemantics failed on generated config: %v", err)
	}
}

func TestDetectPnpmTurbo(t *testing.T) {
	dir := t.TempDir()
	pkgJSON := `{
  "name": "monorepo",
  "scripts": {
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test"
  }
}`
	turboJSON := `{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "lint": {},
    "typecheck": {},
    "test": {}
  }
}`
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(pkgJSON), 0o600); err != nil {
		t.Fatalf("WriteFile package.json failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "turbo.json"), []byte(turboJSON), 0o600); err != nil {
		t.Fatalf("WriteFile turbo.json failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "pnpm-lock.yaml"), []byte("lockfileVersion: '9.0'"), 0o600); err != nil {
		t.Fatalf("WriteFile pnpm-lock.yaml failed: %v", err)
	}

	res, err := Detect(dir)
	if err != nil {
		t.Fatalf("Detect failed: %v", err)
	}
	if res.Ecosystem != EcosystemNodePnpm {
		t.Errorf("expected %s, got %s", EcosystemNodePnpm, res.Ecosystem)
	}
	if s := res.Config.Checks.Setup; len(s) != 1 || s[0].Run != "pnpm install --frozen-lockfile" {
		t.Errorf("unexpected setup: %+v", s)
	}
	expectedJobs := []string{"lint", "typecheck", "unit"}
	for _, job := range expectedJobs {
		if _, ok := res.Config.Checks.Jobs[job]; !ok {
			t.Errorf("expected check job %q not found in checks: %v", job, res.Config.Checks.Jobs)
		}
	}
	if err := config.ValidateSemantics(res.Config); err != nil {
		t.Errorf("ValidateSemantics failed on generated config: %v", err)
	}
}

func TestDetectNpm(t *testing.T) {
	dir := t.TempDir()
	pkgJSON := `{
  "name": "node-app",
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "jest"
  }
}`
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(pkgJSON), 0o600); err != nil {
		t.Fatalf("WriteFile package.json failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package-lock.json"), []byte("{}"), 0o600); err != nil {
		t.Fatalf("WriteFile package-lock.json failed: %v", err)
	}

	res, err := Detect(dir)
	if err != nil {
		t.Fatalf("Detect failed: %v", err)
	}
	if res.Ecosystem != EcosystemNodeNpm {
		t.Errorf("expected %s, got %s", EcosystemNodeNpm, res.Ecosystem)
	}
	if s := res.Config.Checks.Setup; len(s) != 1 || s[0].Run != "npm ci" {
		t.Errorf("unexpected setup: %+v", s)
	}
	expectedJobs := map[string]string{
		"lint":      "npm run lint",
		"typecheck": "npm run typecheck",
		"unit":      "npm test",
	}
	for name, wantRun := range expectedJobs {
		job, ok := res.Config.Checks.Jobs[name]
		if !ok {
			t.Errorf("expected job %q not found", name)
		} else if job.Run != wantRun {
			t.Errorf("job %q run = %q, want %q", name, job.Run, wantRun)
		}
	}
	if err := config.ValidateSemantics(res.Config); err != nil {
		t.Errorf("ValidateSemantics failed on generated config: %v", err)
	}
}

func TestDetectPython(t *testing.T) {
	dir := t.TempDir()
	pyproject := `[project]
name = "my-py-app"
version = "0.1.0"

[tool.ruff]
line-length = 88

[tool.pytest.ini_options]
minversion = "7.0"

[tool.mypy]
strict = true
`
	reqs := "pytest>=7.0\nruff>=0.1.0\nmypy>=1.0\n"
	if err := os.WriteFile(filepath.Join(dir, "pyproject.toml"), []byte(pyproject), 0o600); err != nil {
		t.Fatalf("WriteFile pyproject.toml failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "requirements.txt"), []byte(reqs), 0o600); err != nil {
		t.Fatalf("WriteFile requirements.txt failed: %v", err)
	}

	res, err := Detect(dir)
	if err != nil {
		t.Fatalf("Detect failed: %v", err)
	}
	if res.Ecosystem != EcosystemPython {
		t.Errorf("expected %s, got %s", EcosystemPython, res.Ecosystem)
	}
	expectedJobs := []string{"lint", "typecheck", "test"}
	for _, job := range expectedJobs {
		if _, ok := res.Config.Checks.Jobs[job]; !ok {
			t.Errorf("expected check job %q not found", job)
		}
	}
	if err := config.ValidateSemantics(res.Config); err != nil {
		t.Errorf("ValidateSemantics failed on generated config: %v", err)
	}
}

func TestDetectEmptyDir(t *testing.T) {
	dir := t.TempDir()
	_, err := Detect(dir)
	if !errors.Is(err, ErrNoEcosystemDetected) {
		t.Errorf("expected ErrNoEcosystemDetected, got %v", err)
	}
}

func TestFormatYAML(t *testing.T) {
	cfg := &config.Config{ZeroCIConfig: config.ZeroCIConfig{
		Version: 1,
		Checks: &config.Checks{
			Setup: []config.SetupStep{{Run: "npm ci", Cache: &config.SetupStepCache{Key: []string{"package-lock.json"}, Paths: []string{"node_modules"}}}},
			Jobs:  config.ChecksJobs{"lint": {Run: "npm run lint"}},
		},
	}}
	data, err := FormatYAML(cfg)
	if err != nil {
		t.Fatalf("FormatYAML failed: %v", err)
	}
	parsed, err := config.Parse(data)
	if err != nil {
		t.Fatalf("config.Parse failed on formatted YAML: %v", err)
	}
	if !reflect.DeepEqual(parsed.Checks.Setup, cfg.Checks.Setup) || !reflect.DeepEqual(parsed.Checks.Jobs, cfg.Checks.Jobs) {
		t.Errorf("parsed config mismatch: %+v", parsed.Checks)
	}
}
