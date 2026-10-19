package config

import (
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/testutil"
)

// fakeInfo is an env_file as Stat reports it; sys carries the owner.
type fakeInfo struct {
	mode fs.FileMode
	sys  any
}

func (f fakeInfo) Name() string       { return "env" }
func (f fakeInfo) Size() int64        { return 0 }
func (f fakeInfo) Mode() fs.FileMode  { return f.mode }
func (f fakeInfo) ModTime() time.Time { return time.Time{} }
func (f fakeInfo) IsDir() bool        { return false }
func (f fakeInfo) Sys() any           { return f.sys }

// fixtureStat reports every env_file as present with mode 0600, except
// paths containing "missing", which do not exist.
func fixtureStat(name string) (fs.FileInfo, error) {
	if strings.Contains(name, "missing") {
		return nil, fs.ErrNotExist
	}
	return fakeInfo{mode: 0o600}, nil
}

func parseString(t *testing.T, src string, opts ParseOptions) (*Config, Diagnostics) {
	t.Helper()
	if opts.Stat == nil {
		opts.Stat = fixtureStat
	}
	return Parse([]byte(src), opts)
}

func readFixture(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// findDiag returns the diagnostic at path, failing the test when there is
// none.
func findDiag(t *testing.T, diags Diagnostics, path string) Diagnostic {
	t.Helper()
	for _, d := range diags {
		if d.Path == path {
			return d
		}
	}
	t.Fatalf("no diagnostic at %s; got:\n%s", path, diags.Format("test.yml"))
	return Diagnostic{}
}

func fixtures(t *testing.T, pattern string) []string {
	t.Helper()
	names, err := filepath.Glob(filepath.Join("testdata", pattern))
	if err != nil || len(names) == 0 {
		t.Fatalf("no fixtures match %s: %v", pattern, err)
	}
	for i, n := range names {
		names[i] = filepath.Base(n)
	}
	return names
}

func TestParseMinimal(t *testing.T) {
	cfg, diags := parseString(t, "version: 1\nchecks:\n  jobs:\n    test:\n      run: go test ./...\n", ParseOptions{})
	if len(diags) > 0 {
		t.Fatalf("unexpected diagnostics:\n%s", diags.Format("test.yml"))
	}
	limits := ResolvedLimits{CPUs: 2, MemoryBytes: 4 << 30, Tasks: 512, Timeout: 10 * time.Minute}
	want := &ResolvedChecks{
		On:     OnSpec{PullRequest: true, PushBranches: []string{"main"}},
		Trust:  "collaborators",
		Forks:  "gated",
		Limits: limits,
		Jobs:   []ResolvedJob{{Name: "test", Run: "go test ./...", Limits: limits}},
	}
	if got := cfg.Checks(); !reflect.DeepEqual(got, want) {
		t.Errorf("Checks() = %+v\nwant %+v", got, want)
	}

	cfg, diags = parseString(t, "version: 1\nchecks:\n  services:\n    postgres: {}\n  jobs:\n    test:\n      run: go test ./...\n", ParseOptions{})
	if len(diags) > 0 {
		t.Fatalf("unexpected diagnostics:\n%s", diags.Format("test.yml"))
	}
	if got, want := cfg.Checks().Services.Postgres, (&PostgresService{Image: "postgres:16-alpine", Tmpfs: true}); !reflect.DeepEqual(got, want) {
		t.Errorf("postgres = %+v, want %+v", got, want)
	}
}

func TestParseUnknownKey(t *testing.T) {
	_, diags := parseString(t, readFixture(t, "invalid_unknown_key.yml"), ParseOptions{})
	d := findDiag(t, diags, "checks.jbos")
	if d.Line != 3 || d.Severity != SeverityError {
		t.Errorf("diagnostic = %+v, want an error on line 3", d)
	}
	if !strings.Contains(d.Fix, `"jobs"`) {
		t.Errorf("fix %q does not suggest jobs", d.Fix)
	}
}

func TestParseWrongVersion(t *testing.T) {
	_, diags := parseString(t, readFixture(t, "invalid_version.yml"), ParseOptions{})
	d := findDiag(t, diags, "version")
	if d.Line != 1 || !strings.Contains(d.Message, "unsupported version 2") {
		t.Errorf("diagnostic = %+v", d)
	}
}

func TestParseDuplicateKey(t *testing.T) {
	cfg, diags := parseString(t, readFixture(t, "invalid_duplicate_key.yml"), ParseOptions{})
	if cfg != nil {
		t.Error("Parse returned a config for a file with errors")
	}
	d := findDiag(t, diags, "checks.jobs.test")
	if d.Line != 6 || !strings.Contains(d.Message, "first defined on line 4") {
		t.Errorf("diagnostic = %+v", d)
	}
}

func TestParseValidFixtures(t *testing.T) {
	for _, name := range fixtures(t, "valid_*.yml") {
		t.Run(name, func(t *testing.T) {
			cfg, diags := parseString(t, readFixture(t, name), ParseOptions{})
			if len(diags) > 0 {
				t.Fatalf("unexpected diagnostics:\n%s", diags.Format(name))
			}
			if len(cfg.Checks().Jobs) == 0 {
				t.Error("no jobs resolved")
			}
		})
	}
}

func TestParseInvalidFixturesGolden(t *testing.T) {
	for _, name := range fixtures(t, "invalid_*.yml") {
		t.Run(name, func(t *testing.T) {
			cfg, diags := parseString(t, readFixture(t, name), ParseOptions{})
			if cfg != nil || !diags.HasErrors() {
				t.Fatalf("Parse accepted %s:\n%s", name, diags.Format(name))
			}
			testutil.Golden(t, strings.TrimSuffix(name, ".yml"), []byte(diags.Format(name)))
		})
	}
}

func TestMessagesASCII(t *testing.T) {
	for _, name := range fixtures(t, "invalid_*.yml") {
		_, diags := parseString(t, readFixture(t, name), ParseOptions{})
		for _, d := range diags {
			for _, text := range []string{d.Message, d.Fix} {
				for _, r := range text {
					if r > 0x7f {
						t.Errorf("%s: non-ASCII rune %U in %q", name, r, text)
					}
				}
			}
		}
	}
}
