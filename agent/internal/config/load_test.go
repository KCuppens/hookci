package config

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/egress"
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

func TestFromRoot(t *testing.T) {
	src := "version: 1\nchecks:\n  jobs:\n    lint:\n      run: npm run lint\n    test:\n      run: go test ./...\n      needs: [lint]\n"
	parsed, diags := parseString(t, src, ParseOptions{})
	if len(diags) > 0 {
		t.Fatalf("unexpected diagnostics:\n%s", diags.Format("test.yml"))
	}
	built, diags := FromRoot(ZeroCIConfig{Version: 1, Checks: &Checks{Jobs: ChecksJobs{
		"lint": {Run: "npm run lint"},
		"test": {Run: "go test ./...", Needs: []string{"lint"}},
	}}})
	if len(diags) > 0 {
		t.Fatalf("unexpected diagnostics:\n%s", diags.Format("root"))
	}
	if !reflect.DeepEqual(built.ZeroCIConfig, parsed.ZeroCIConfig) {
		t.Errorf("FromRoot config = %+v\nParse config = %+v", built.ZeroCIConfig, parsed.ZeroCIConfig)
	}
	if !reflect.DeepEqual(built.Checks(), parsed.Checks()) {
		t.Errorf("FromRoot Checks() = %+v\nParse Checks() = %+v", built.Checks(), parsed.Checks())
	}

	_, diags = FromRoot(ZeroCIConfig{Version: 1, Checks: &Checks{Jobs: ChecksJobs{"Bad Name": {Run: "true"}}}})
	if !diags.HasErrors() {
		t.Error("FromRoot accepted an invalid job name")
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

func TestEgressOneDiagnosticPerEntry(t *testing.T) {
	for name, want := range map[string]int{"invalid_egress.yml": 9, "invalid_egress_port.yml": 2} {
		_, diags := parseString(t, readFixture(t, name), ParseOptions{})
		if len(diags) != want {
			t.Fatalf("%s: got %d diagnostics, want %d:\n%s", name, len(diags), want, diags.Format(name))
		}
		for i, d := range diags {
			if p := fmt.Sprintf("checks.egress[%d]", i); d.Path != p || d.Severity != SeverityError || d.Fix == "" {
				t.Errorf("%s: diagnostic %d = %+v, want an error with a fix at %s", name, i, d, p)
			}
		}
	}
}

// TestEgressMatchesAllowList keeps checks.egress in step with the egress
// proxy: whatever config accepts, egress.NewAllowList must accept too, and
// whatever the proxy rejects, config rejects. Config is stricter only where
// the proxy would normalize or not care (case, a trailing dot, label shape).
func TestEgressMatchesAllowList(t *testing.T) {
	for _, tc := range []struct {
		entry    string
		ok       bool // config accepts it
		stricter bool // config rejects it although the proxy accepts it
	}{
		{entry: "registry.npmjs.org", ok: true},
		{entry: "github.com", ok: true},
		{entry: "api.example.com", ok: true},
		{entry: "localhost", ok: true},
		{entry: "1password.com", ok: true},
		{entry: "xn--bcher-kva.example", ok: true},
		{entry: "a-b.c0.example", ok: true},
		{entry: strings.Repeat("abc.", 62) + "abcde", ok: true},
		{entry: ""},
		{entry: "*"},
		{entry: "*.github.com"},
		{entry: "api.*.com"},
		{entry: "api.example.com:443"},
		{entry: "api.example.com:8080"},
		{entry: "api.example.com:"},
		{entry: "10.0.0.1"},
		{entry: "10.0.0.1:443"},
		{entry: "::1"},
		{entry: "[::1]"},
		{entry: "[2001:db8::1]:443"},
		{entry: "https://api.example.com"},
		{entry: "api.example.com/v1"},
		{entry: "api_example.com"},
		{entry: "a b.com"},
		{entry: "\u00e9.example.com"},
		{entry: strings.Repeat("abc.", 63) + "ab"},
		{entry: "Registry.NPMjs.org", stricter: true},
		{entry: "example.com.", stricter: true},
		{entry: "-bad.example.com", stricter: true},
		{entry: "a..b.com", stricter: true},
		{entry: "example.123", stricter: true},
		{entry: "1.2.3", stricter: true},
	} {
		t.Run(tc.entry, func(t *testing.T) {
			_, diags := parseString(t, oneJob+"  egress:\n    - "+strconv.Quote(tc.entry)+"\n", ParseOptions{})
			if tc.ok != (len(diags) == 0) {
				t.Fatalf("config accepts = %v, want %v:\n%s", len(diags) == 0, tc.ok, diags.Format("test.yml"))
			}
			if !tc.ok && (len(diags) != 1 || diags[0].Path != "checks.egress[0]") {
				t.Errorf("want one diagnostic at checks.egress[0]:\n%s", diags.Format("test.yml"))
			}
			_, _, err := egress.NewAllowList(true, []string{tc.entry})
			if proxyOK := err == nil; proxyOK != (tc.ok || tc.stricter) {
				t.Errorf("NewAllowList accepts = %v (err %v), want %v", proxyOK, err, tc.ok || tc.stricter)
			}
		})
	}
}
