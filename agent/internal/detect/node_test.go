package detect

import (
	"io/fs"
	"reflect"
	"slices"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/KCuppens/hookci/agent/internal/config"
)

func TestDetectPnpmTurbo(t *testing.T) {
	r := detectFixture(t, "pnpm-turbo")
	c := checksOf(t, r)
	if len(c.Setup) != 1 || c.Setup[0].Run != "pnpm install --frozen-lockfile" {
		t.Fatalf("setup = %+v", c.Setup)
	}
	if got, want := jobNames(r), []string{"lint", "typecheck", "unit"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("jobs = %v, want %v", got, want)
	}
	for _, name := range []string{"lint", "typecheck", "unit"} {
		run := mustJob(t, r, name).Run
		if !strings.Contains(run, "pnpm exec turbo run") || !strings.Contains(run, "--filter=...[$HOOKCI_BASE_SHA]") {
			t.Errorf("%s run = %q, want pnpm exec turbo run with the base filter", name, run)
		}
	}
	if got, want := mustJob(t, r, "unit").Run, "sh -c 'pnpm exec turbo run test:unit ${HOOKCI_BASE_SHA:+--filter=...[$HOOKCI_BASE_SHA]}'"; got != want {
		t.Errorf("unit run = %q, want %q", got, want)
	}
	paths := c.Setup[0].Cache.Paths
	for _, want := range []string{"apps/web/node_modules", "node_modules", "packages/ui/node_modules"} {
		if !slices.Contains(paths, want) {
			t.Errorf("cache paths %v lack %q", paths, want)
		}
	}
	if !slices.IsSorted(paths) {
		t.Errorf("cache paths %v are not sorted", paths)
	}
	if got, want := c.Setup[0].Cache.Key, []string{"pnpm-lock.yaml"}; !reflect.DeepEqual(got, want) {
		t.Errorf("cache key = %v, want %v", got, want)
	}
	if !containsSubstring(r.Notes, "turbo must be a devDependency") {
		t.Errorf("notes %q lack the turbo devDependency note", r.Notes)
	}
	if !containsSubstring(r.Notes, "node 20 (from .nvmrc)") {
		t.Errorf("notes %q lack the .nvmrc version note", r.Notes)
	}
}

func TestDetectTurbo(t *testing.T) {
	t.Run("v1 pipeline and dev server skip", func(t *testing.T) {
		r := detectFS(t, fstest.MapFS{
			"package.json":      file(`{"scripts": {"lint": "eslint ."}}`),
			"package-lock.json": file("{}"),
			"turbo.json": file(`{"pipeline": {
				"type-check": {},
				"test": {},
				"lint": {"cache": false, "persistent": true}
			}}`),
		})
		if got, want := jobNames(r), []string{"test", "typecheck"}; !reflect.DeepEqual(got, want) {
			t.Fatalf("jobs = %v, want %v (persistent uncached lint skipped, scripts ignored)", got, want)
		}
		if got, want := mustJob(t, r, "typecheck").Run, "sh -c 'npx --no-install turbo run type-check ${HOOKCI_BASE_SHA:+--filter=...[$HOOKCI_BASE_SHA]}'"; got != want {
			t.Errorf("typecheck run = %q, want %q", got, want)
		}
	})
	t.Run("cache false alone is kept", func(t *testing.T) {
		r := detectFS(t, fstest.MapFS{
			"package.json": file(`{}`),
			"yarn.lock":    file(""),
			"turbo.json":   file(`{"tasks": {"lint": {"cache": false}, "test": {"persistent": true}}}`),
		})
		if got, want := jobNames(r), []string{"lint", "test"}; !reflect.DeepEqual(got, want) {
			t.Fatalf("jobs = %v, want %v", got, want)
		}
		if got := mustJob(t, r, "lint").Run; !strings.HasPrefix(got, "sh -c 'yarn turbo run lint ") {
			t.Errorf("lint run = %q, want the yarn exec form", got)
		}
	})
}

func TestDetectNpm(t *testing.T) {
	r := detectFixture(t, "npm")
	c := checksOf(t, r)
	if len(c.Setup) != 1 || c.Setup[0].Run != "npm ci" {
		t.Fatalf("setup = %+v, want npm ci", c.Setup)
	}
	if got, want := c.Setup[0].Cache.Key, []string{"package-lock.json"}; !reflect.DeepEqual(got, want) {
		t.Errorf("cache key = %v, want %v", got, want)
	}
	if got, want := jobNames(r), []string{"lint", "typecheck", "unit"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("jobs = %v, want %v", got, want)
	}
	lint := mustJob(t, r, "lint")
	if lint.Run != "npm run lint" || lint.Annotate == nil || *lint.Annotate != config.JobAnnotateEslint {
		t.Errorf("lint = %+v, want npm run lint with annotate eslint", lint)
	}
	typecheck := mustJob(t, r, "typecheck")
	if typecheck.Run != "npm run type-check" || typecheck.Annotate == nil || *typecheck.Annotate != config.JobAnnotateTsc {
		t.Errorf("typecheck = %+v, want npm run type-check with annotate tsc", typecheck)
	}
	if got := mustJob(t, r, "unit").Run; got != "npm run test:unit" {
		t.Errorf("unit run = %q, want test:unit preferred over test", got)
	}
	if !containsSubstring(r.Notes, "node >=20 (from engines.node)") {
		t.Errorf("notes %q lack the engines.node note", r.Notes)
	}

	t.Run("placeholder test skipped", func(t *testing.T) {
		r := detectFS(t, fstest.MapFS{
			"package.json":      file(`{"scripts": {"lint": "eslint .", "test": "echo \"Error: no test specified\" && exit 1"}}`),
			"package-lock.json": file("{}"),
		})
		if got, want := jobNames(r), []string{"lint"}; !reflect.DeepEqual(got, want) {
			t.Fatalf("jobs = %v, want %v", got, want)
		}
	})
	t.Run("test script and typecheck order", func(t *testing.T) {
		r := detectFS(t, fstest.MapFS{
			"package.json":      file(`{"scripts": {"test": "node test.js", "tsc": "tsc", "type-check": "tsc -p ."}}`),
			"package-lock.json": file("{}"),
		})
		if got, want := jobNames(r), []string{"test", "typecheck"}; !reflect.DeepEqual(got, want) {
			t.Fatalf("jobs = %v, want %v", got, want)
		}
		if got := mustJob(t, r, "test").Run; got != "npm run test" {
			t.Errorf("test run = %q", got)
		}
		if got := mustJob(t, r, "typecheck").Run; got != "npm run type-check" {
			t.Errorf("typecheck run = %q, want type-check before tsc", got)
		}
	})
	t.Run("no lockfile", func(t *testing.T) {
		r := detectFS(t, fstest.MapFS{"package.json": file(`{"scripts": {"lint": "eslint ."}}`)})
		c := checksOf(t, r)
		if c.Setup[0].Run != "npm install" {
			t.Errorf("setup = %q, want npm install", c.Setup[0].Run)
		}
		if got, want := c.Setup[0].Cache.Key, []string{"package.json"}; !reflect.DeepEqual(got, want) {
			t.Errorf("cache key = %v, want %v", got, want)
		}
		if !slices.Contains(r.Notes, "no lockfile, install is not reproducible") {
			t.Errorf("notes %q lack the reproducibility note", r.Notes)
		}
	})
}

func TestDetectYarnBerryVsClassic(t *testing.T) {
	berry := detectFixture(t, "yarn")
	if got := checksOf(t, berry).Setup[0].Run; got != "yarn install --immutable" {
		t.Errorf("with .yarnrc.yml: setup = %q, want yarn install --immutable", got)
	}
	if got, want := checksOf(t, berry).Setup[0].Cache.Paths, []string{"node_modules", "packages/core/node_modules"}; !reflect.DeepEqual(got, want) {
		t.Errorf("cache paths = %v, want %v from package.json workspaces", got, want)
	}
	if got := mustJob(t, berry, "test").Run; got != "yarn run test" {
		t.Errorf("test run = %q", got)
	}

	classic := detectFS(t, fstest.MapFS{
		"package.json":           file(`{"workspaces": {"packages": ["apps/*", "!apps/skip"]}, "scripts": {"test": "jest"}}`),
		"yarn.lock":              file(""),
		"apps/web/package.json":  file("{}"),
		"apps/skip/package.json": file("{}"),
		"apps/notes/README.md":   file(""),
		"apps/link":              &fstest.MapFile{Mode: fs.ModeSymlink, Data: []byte("web")},
	})
	if got := checksOf(t, classic).Setup[0].Run; got != "yarn install --frozen-lockfile" {
		t.Errorf("without .yarnrc.yml: setup = %q, want yarn install --frozen-lockfile", got)
	}
	want := []string{"apps/web/node_modules", "node_modules"}
	if got := checksOf(t, classic).Setup[0].Cache.Paths; !reflect.DeepEqual(got, want) {
		t.Errorf("cache paths = %v, want %v (globs expanded; negated, package-less and symlinked dirs skipped)", got, want)
	}
}

func TestDetectBun(t *testing.T) {
	r := detectFixture(t, "bun")
	if got := checksOf(t, r).Setup[0].Run; got != "bun install --frozen-lockfile" {
		t.Errorf("setup = %q, want bun install --frozen-lockfile", got)
	}
	if got := mustJob(t, r, "test").Run; got != "bun run test" {
		t.Errorf("test run = %q", got)
	}

	text := detectFS(t, fstest.MapFS{"package.json": file(`{"scripts": {"test": "bun test"}}`), "bun.lock": file(""), "yarn.lock": file("")})
	if got := checksOf(t, text).Setup[0].Run; got != "bun install --frozen-lockfile" {
		t.Errorf("bun.lock beats yarn.lock: setup = %q", got)
	}
}

func TestDetectPackageManagerField(t *testing.T) {
	cases := []struct {
		name    string
		fsys    fstest.MapFS
		want    packageManager
		lockful bool
	}{
		{
			name:    "field overrides lockfile priority",
			fsys:    fstest.MapFS{"pnpm-lock.yaml": file(""), "yarn.lock": file("")},
			want:    packageManager{Name: "yarn", Lock: "yarn.lock", Install: "yarn install --frozen-lockfile", Exec: "yarn"},
			lockful: true,
		},
		{
			name:    "field without its lockfile",
			fsys:    fstest.MapFS{"package-lock.json": file("")},
			want:    packageManager{Name: "yarn", Install: "yarn install", Exec: "yarn"},
			lockful: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, lockful := detectPackageManager(tc.fsys, packageJSON{PackageManager: "yarn@1.22.19"})
			if got != tc.want || lockful != tc.lockful {
				t.Errorf("detectPackageManager = %+v, %v; want %+v, %v", got, lockful, tc.want, tc.lockful)
			}
		})
	}

	for field, want := range map[string]string{
		"pnpm@9.1.0": "pnpm",
		"npm@10.2.0": "npm",
		"bun@1.1.0":  "bun",
		"deno@2.0.0": "bun",
	} {
		got, _ := detectPackageManager(fstest.MapFS{"bun.lockb": file("")}, packageJSON{PackageManager: field})
		if got.Name != want {
			t.Errorf("packageManager %q with bun.lockb: got %s, want %s", field, got.Name, want)
		}
	}

	r := detectFS(t, fstest.MapFS{
		"package.json":      file(`{"packageManager": "pnpm@9.1.0+sha512.abc", "scripts": {"lint": "eslint ."}}`),
		"package-lock.json": file("{}"),
	})
	if got := checksOf(t, r).Setup[0].Run; got != "pnpm install" {
		t.Errorf("setup = %q, want pnpm install (field wins, no pnpm lockfile)", got)
	}
	if got := mustJob(t, r, "lint").Run; got != "pnpm run lint" {
		t.Errorf("lint run = %q", got)
	}
	for _, want := range []string{"package manager: pnpm (packageManager field)", "no lockfile, install is not reproducible", "pnpm@9.1.0 (from packageManager), not installed by hookci"} {
		if !slices.Contains(r.Notes, want) {
			t.Errorf("notes %q lack %q", r.Notes, want)
		}
	}
}

func TestNodeVersionNoteOrder(t *testing.T) {
	pkg := packageJSON{PackageManager: "pnpm@9.0.0"}
	pkg.Engines = []byte(`{"node": "18.x"}`)
	cases := []struct {
		name string
		fsys fstest.MapFS
		pkg  packageJSON
		want string
	}{
		{".nvmrc first", fstest.MapFS{".nvmrc": file("v22.1.0\n"), ".node-version": file("20\n")}, pkg, "node v22.1.0 (from .nvmrc), not installed by hookci"},
		{".node-version second", fstest.MapFS{".node-version": file("20\n")}, pkg, "node 20 (from .node-version), not installed by hookci"},
		{"engines third", fstest.MapFS{}, pkg, "node 18.x (from engines.node), not installed by hookci"},
		{"packageManager last", fstest.MapFS{}, packageJSON{PackageManager: "pnpm@9.0.0"}, "pnpm@9.0.0 (from packageManager), not installed by hookci"},
		{"nothing", fstest.MapFS{}, packageJSON{}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, _ := nodeVersionNote(tc.fsys, tc.pkg); got != tc.want {
				t.Errorf("note = %q, want %q", got, tc.want)
			}
		})
	}
}
