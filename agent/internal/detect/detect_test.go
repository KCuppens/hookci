package detect

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/testutil"
)

// fixtureDir returns examples/detect/<name>, located from this file so the
// test does not depend on the working directory.
func fixtureDir(t *testing.T, name string) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "examples", "detect", name)
}

// fixtureNames lists every dir under examples/detect and checks that the
// fixtures the detection rules are pinned against are all there.
func fixtureNames(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(fixtureDir(t, ""))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	for _, want := range []string{"pnpm-turbo", "npm", "yarn", "bun", "go", "rust", "python-uv", "python-pip", "compose-postgres", "empty"} {
		if !slices.Contains(names, want) {
			t.Fatalf("fixture examples/detect/%s is missing", want)
		}
	}
	return names
}

func detectFixture(t *testing.T, name string) *Result {
	t.Helper()
	r, err := DetectDir(fixtureDir(t, name))
	if err != nil {
		t.Fatalf("DetectDir(%s): %v", name, err)
	}
	return r
}

func detectFS(t *testing.T, fsys fs.FS) *Result {
	t.Helper()
	r, err := Detect(fsys)
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	return r
}

func checksOf(t *testing.T, r *Result) *config.Checks {
	t.Helper()
	if r.Config.HookCIConfig.Checks == nil {
		t.Fatal("no checks in detected config")
	}
	return r.Config.HookCIConfig.Checks
}

func jobNames(r *Result) []string {
	if r.Config.HookCIConfig.Checks == nil {
		return nil
	}
	return sortedKeys(r.Config.HookCIConfig.Checks.Jobs)
}

func mustJob(t *testing.T, r *Result, name string) config.Job {
	t.Helper()
	job, ok := checksOf(t, r).Jobs[name]
	if !ok {
		t.Fatalf("job %q not detected; jobs: %v", name, jobNames(r))
	}
	return job
}

func setupRuns(r *Result) []string {
	var runs []string
	for _, s := range r.Config.HookCIConfig.Checks.Setup {
		runs = append(runs, s.Run)
	}
	return runs
}

func file(s string) *fstest.MapFile { return &fstest.MapFile{Data: []byte(s)} }

func TestDetectFixtures(t *testing.T) {
	for _, name := range fixtureNames(t) {
		t.Run(name, func(t *testing.T) {
			dir := fixtureDir(t, name)
			r, err := DetectDir(dir)
			if name == "empty" {
				if !errors.Is(err, ErrNothingDetected) {
					t.Fatalf("DetectDir(empty) error = %v, want ErrNothingDetected", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("DetectDir: %v", err)
			}
			out, err := Render(r)
			if err != nil {
				t.Fatalf("Render: %v", err)
			}
			testutil.GoldenFile(t, filepath.Join(dir, "expected.hookci.yml"), out)
			if _, diags := config.Parse(out, config.ParseOptions{}); diags.HasErrors() {
				t.Fatalf("rendered output does not parse:\n%s\n%s", diags.Format("expected.hookci.yml"), out)
			}
		})
	}
}

func TestDetectGo(t *testing.T) {
	r := detectFixture(t, "go")
	if got, want := jobNames(r), []string{"go-test", "go-vet"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("jobs = %v, want %v", got, want)
	}
	if got := mustJob(t, r, "go-vet").Run; got != "go vet ./..." {
		t.Errorf("go-vet run = %q", got)
	}
	if got := mustJob(t, r, "go-test").Run; got != "go test ./..." {
		t.Errorf("go-test run = %q", got)
	}
	setup := checksOf(t, r).Setup
	if len(setup) != 1 || setup[0].Run != "go mod download" {
		t.Fatalf("setup = %+v", setup)
	}
	if got, want := setup[0].Cache.Key, []string{"go.sum"}; !reflect.DeepEqual(got, want) {
		t.Errorf("cache key = %v, want %v", got, want)
	}
	if got, want := setup[0].Cache.Paths, []string{"~/go/pkg/mod", "~/.cache/go-build"}; !reflect.DeepEqual(got, want) {
		t.Errorf("cache paths = %v, want %v", got, want)
	}
}

func TestDetectRust(t *testing.T) {
	r := detectFixture(t, "rust")
	if got, want := jobNames(r), []string{"cargo-test", "clippy"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("jobs = %v, want %v", got, want)
	}
	if got := mustJob(t, r, "clippy").Run; got != "cargo clippy --all-targets -- -D warnings" {
		t.Errorf("clippy run = %q", got)
	}
	if got := mustJob(t, r, "cargo-test").Run; got != "cargo test" {
		t.Errorf("cargo-test run = %q", got)
	}
	setup := checksOf(t, r).Setup
	if len(setup) != 1 || setup[0].Run != "cargo fetch" {
		t.Fatalf("setup = %+v", setup)
	}
	if got, want := setup[0].Cache.Key, []string{"Cargo.lock"}; !reflect.DeepEqual(got, want) {
		t.Errorf("cache key = %v, want %v", got, want)
	}
	if got, want := setup[0].Cache.Paths, []string{"~/.cargo/registry", "target"}; !reflect.DeepEqual(got, want) {
		t.Errorf("cache paths = %v, want %v", got, want)
	}
}

func TestDetectPython(t *testing.T) {
	t.Run("uv", func(t *testing.T) {
		r := detectFixture(t, "python-uv")
		setup := checksOf(t, r).Setup
		if len(setup) != 1 || setup[0].Run != "uv sync --frozen" {
			t.Fatalf("setup = %+v", setup)
		}
		if got, want := setup[0].Cache.Key, []string{"uv.lock"}; !reflect.DeepEqual(got, want) {
			t.Errorf("cache key = %v, want %v", got, want)
		}
		if got, want := setup[0].Cache.Paths, []string{".venv"}; !reflect.DeepEqual(got, want) {
			t.Errorf("cache paths = %v, want %v", got, want)
		}
		if got := mustJob(t, r, "ruff").Run; got != "uv run ruff check ." {
			t.Errorf("ruff run = %q", got)
		}
		if got := mustJob(t, r, "pytest").Run; got != "uv run pytest" {
			t.Errorf("pytest run = %q", got)
		}
	})
	t.Run("pip requirements", func(t *testing.T) {
		r := detectFixture(t, "python-pip")
		setup := checksOf(t, r).Setup
		if len(setup) != 1 || setup[0].Run != "python -m venv .venv && .venv/bin/pip install -r requirements.txt" {
			t.Fatalf("setup = %+v", setup)
		}
		if got, want := setup[0].Cache.Key, []string{"requirements.txt"}; !reflect.DeepEqual(got, want) {
			t.Errorf("cache key = %v, want %v", got, want)
		}
		if got, want := jobNames(r), []string{"pytest"}; !reflect.DeepEqual(got, want) {
			t.Fatalf("jobs = %v, want %v (no ruff config)", got, want)
		}
		if got := mustJob(t, r, "pytest").Run; got != ".venv/bin/pytest" {
			t.Errorf("pytest run = %q", got)
		}
	})
	t.Run("pip pyproject", func(t *testing.T) {
		r := detectFS(t, fstest.MapFS{
			"pyproject.toml":   file("[project]\nname = \"x\"\n"),
			"requirements.txt": file("pytest\n"),
			"ruff.toml":        file("line-length = 100\n"),
		})
		setup := checksOf(t, r).Setup
		if len(setup) != 1 || setup[0].Run != "python -m venv .venv && .venv/bin/pip install -e ." {
			t.Fatalf("setup = %+v", setup)
		}
		if got, want := setup[0].Cache.Key, []string{"pyproject.toml"}; !reflect.DeepEqual(got, want) {
			t.Errorf("cache key = %v, want %v", got, want)
		}
		if got := mustJob(t, r, "ruff").Run; got != ".venv/bin/ruff check ." {
			t.Errorf("ruff run = %q", got)
		}
	})

	gating := []struct {
		name       string
		fsys       fstest.MapFS
		ruff, test bool
	}{
		{"no ruff config, no tests", fstest.MapFS{"pyproject.toml": file("[project]\nname = \"x\"\n# [tool.ruff] in a comment\n[tool.ruffle]\n")}, false, false},
		{"tool.ruff table", fstest.MapFS{"pyproject.toml": file("[tool.ruff]\n")}, true, false},
		{"tool.ruff subtable", fstest.MapFS{"pyproject.toml": file("  [tool.ruff.lint]\n")}, true, false},
		{".ruff.toml", fstest.MapFS{"requirements.txt": file(""), ".ruff.toml": file("")}, true, false},
		{"tests dir", fstest.MapFS{"requirements.txt": file(""), "tests/test_a.py": file("")}, false, true},
		{"test dir", fstest.MapFS{"requirements.txt": file(""), "test/test_a.py": file("")}, false, true},
		{"tests is a file", fstest.MapFS{"requirements.txt": file(""), "tests": file("")}, false, false},
	}
	for _, tc := range gating {
		t.Run(tc.name, func(t *testing.T) {
			if !tc.ruff && !tc.test {
				if _, err := Detect(tc.fsys); !errors.Is(err, ErrNothingDetected) {
					t.Errorf("error = %v, want ErrNothingDetected (setup but no jobs)", err)
				}
				return
			}
			r := detectFS(t, tc.fsys)
			jobs := checksOf(t, r).Jobs
			if _, ok := jobs["ruff"]; ok != tc.ruff {
				t.Errorf("ruff job present = %v, want %v", ok, tc.ruff)
			}
			if _, ok := jobs["pytest"]; ok != tc.test {
				t.Errorf("pytest job present = %v, want %v", ok, tc.test)
			}
		})
	}
}

func TestDetectComposePostgres(t *testing.T) {
	r := detectFixture(t, "compose-postgres")
	svc := checksOf(t, r).Services
	if svc == nil || svc.Postgres == nil {
		t.Fatal("no postgres service detected")
	}
	if svc.Postgres.Image != "postgres:16-alpine" || !svc.Postgres.Tmpfs {
		t.Errorf("postgres = %+v, want postgres:16-alpine on tmpfs", svc.Postgres)
	}
	if !containsSubstring(r.Notes, "postgres") {
		t.Errorf("notes %q do not mention postgres", r.Notes)
	}
	if !slices.Contains(r.Sources, "docker-compose.yml") {
		t.Errorf("sources %v lack docker-compose.yml", r.Sources)
	}

	t.Run("no postgres adds nothing", func(t *testing.T) {
		r := detectFS(t, fstest.MapFS{
			"go.mod":             file("module x\n"),
			"docker-compose.yml": file("services:\n  cache:\n    image: redis:7\n"),
		})
		if svc := checksOf(t, r).Services; svc != nil {
			t.Errorf("services = %+v, want none", svc)
		}
		if slices.Contains(r.Sources, "docker-compose.yml") || containsSubstring(r.Notes, "postgres") {
			t.Errorf("compose without postgres left a trace: sources %v notes %q", r.Sources, r.Notes)
		}
	})
	t.Run("first sorted file with postgres wins", func(t *testing.T) {
		r := detectFS(t, fstest.MapFS{
			"go.mod":                  file("module x\n"),
			"compose.yaml":            file("services:\n  db:\n    image: postgres:15\n"),
			"docker-compose.dev.yml":  file("services:\n  db:\n    image: redis:7\n"),
			"docker-compose.test.yml": file("services:\n  db:\n    image: postgres:16.2\n"),
			"other.yml":               file("services:\n  db:\n    image: postgres:14\n"),
		})
		if got := checksOf(t, r).Services.Postgres.Image; got != "postgres:15-alpine" {
			t.Errorf("image = %q, want postgres:15-alpine from compose.yaml", got)
		}
	})
	t.Run("non-major tags stay verbatim", func(t *testing.T) {
		for image, want := range map[string]string{
			"postgres:16":           "postgres:16-alpine",
			"postgres:16.2":         "postgres:16.2",
			"postgres:16-bookworm":  "postgres:16-bookworm",
			"postgres":              "postgres",
			"postgres@sha256:abc12": "postgres@sha256:abc12",
		} {
			if got := postgresImage(image); got != want {
				t.Errorf("postgresImage(%q) = %q, want %q", image, got, want)
			}
		}
	})
	t.Run("compose alone detects nothing", func(t *testing.T) {
		_, err := Detect(fstest.MapFS{"docker-compose.yml": file("services:\n  db:\n    image: postgres:16\n")})
		if !errors.Is(err, ErrNothingDetected) {
			t.Fatalf("error = %v, want ErrNothingDetected", err)
		}
	})
}

func TestDetectNothing(t *testing.T) {
	if _, err := DetectDir(t.TempDir()); !errors.Is(err, ErrNothingDetected) {
		t.Errorf("empty dir: error = %v, want ErrNothingDetected", err)
	}
	if _, err := Detect(fstest.MapFS{"README.md": file("# hello\n")}); !errors.Is(err, ErrNothingDetected) {
		t.Errorf("README.md only: error = %v, want ErrNothingDetected", err)
	}
	_, err := Detect(fstest.MapFS{
		"package.json":      file(`{"scripts": {"build": "tsc", "test": "echo \"Error: no test specified\" && exit 1"}}`),
		"package-lock.json": file("{}"),
	})
	if !errors.Is(err, ErrNothingDetected) {
		t.Errorf("node without matching scripts: error = %v, want ErrNothingDetected", err)
	}
}

func TestDetectDeterministic(t *testing.T) {
	var first []byte
	for i := range 20 {
		out, err := Render(detectFixture(t, "pnpm-turbo"))
		if err != nil {
			t.Fatalf("Render: %v", err)
		}
		if i == 0 {
			first = out
			continue
		}
		if !bytes.Equal(out, first) {
			t.Fatalf("run %d differs:\n%s\n--- first ---\n%s", i, out, first)
		}
	}
}

func TestDetectNeverDeploys(t *testing.T) {
	for _, name := range fixtureNames(t) {
		if name == "empty" {
			continue
		}
		r := detectFixture(t, name)
		if len(r.Config.Deployments) != 0 {
			t.Errorf("%s: deployments = %v, want none", name, r.Config.Deployments)
		}
	}
}

func TestDetectMergeOrder(t *testing.T) {
	r := detectFS(t, fstest.MapFS{
		"requirements.txt":  file(""),
		"Cargo.toml":        file(""),
		"go.mod":            file("module x\n"),
		"package.json":      file(`{"scripts": {"lint": "eslint ."}}`),
		"package-lock.json": file("{}"),
	})
	want := []string{"npm ci", "go mod download", "cargo fetch", "python -m venv .venv && .venv/bin/pip install -r requirements.txt"}
	if got := setupRuns(r); !reflect.DeepEqual(got, want) {
		t.Errorf("setup order = %q, want %q", got, want)
	}
	wantSources := []string{"Cargo.toml", "go.mod", "package-lock.json", "package.json", "requirements.txt"}
	if !reflect.DeepEqual(r.Sources, wantSources) {
		t.Errorf("sources = %v, want %v", r.Sources, wantSources)
	}
}

func TestDetectJobCollisionPrefix(t *testing.T) {
	saved := ecosystems
	t.Cleanup(func() { ecosystems = saved })
	stub := func(eco string) func(fs.FS) (*partial, error) {
		return func(fs.FS) (*partial, error) {
			return &partial{ecosystem: eco, jobs: map[string]config.Job{"test": {Run: eco + " test"}}}, nil
		}
	}
	ecosystems = []func(fs.FS) (*partial, error){stub("node"), stub("go")}
	r := detectFS(t, fstest.MapFS{})
	if got, want := jobNames(r), []string{"go-test", "test"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("jobs = %v, want %v", got, want)
	}
	if got := mustJob(t, r, "test").Run; got != "node test" {
		t.Errorf("earlier ecosystem keeps the bare name, got run %q", got)
	}
	if got := mustJob(t, r, "go-test").Run; got != "go test" {
		t.Errorf("later ecosystem gets the prefix, got run %q", got)
	}
}

func TestDetectMalformedInput(t *testing.T) {
	for name, fsys := range map[string]fstest.MapFS{
		"package.json":        {"package.json": file("{")},
		"turbo.json":          {"package.json": file("{}"), "turbo.json": file("{")},
		"pnpm-workspace.yaml": {"package.json": file("{}"), "pnpm-workspace.yaml": file("packages: {")},
		"docker-compose.yml":  {"go.mod": file(""), "docker-compose.yml": file("services: [")},
	} {
		_, err := Detect(fsys)
		if err == nil || errors.Is(err, ErrNothingDetected) || !strings.Contains(err.Error(), name) {
			t.Errorf("%s: error = %v, want a parse error naming the file", name, err)
		}
	}
}

func containsSubstring(ss []string, sub string) bool {
	for _, s := range ss {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}
