package config

import (
	"io/fs"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"testing/fstest"
)

const oneJob = "version: 1\nchecks:\n  jobs:\n    test:\n      run: go test ./...\n"

func TestReservedJobName(t *testing.T) {
	src := "version: 1\nchecks:\n  jobs:\n    test:\n      run: go test ./...\n    setup:\n      run: make\n"
	_, diags := parseString(t, src, ParseOptions{})
	d := findDiag(t, diags, "checks.jobs.setup")
	if d.Severity != SeverityError || d.Line != 6 || d.Message != `job name "setup" is reserved for the setup phase` || !strings.Contains(d.Fix, "rename the job") {
		t.Errorf("reserved name diagnostic = %+v", d)
	}
}

func TestNeedsUnknown(t *testing.T) {
	_, diags := parseString(t, readFixture(t, "invalid_needs.yml"), ParseOptions{})
	d := findDiag(t, diags, "checks.jobs.test.needs[0]")
	if d.Line != 9 || !strings.Contains(d.Message, `unknown job "biuld"`) {
		t.Errorf("diagnostic = %+v", d)
	}
	if d.Fix != "known jobs: a, b, c, lint, test" {
		t.Errorf("fix = %q, want the known jobs listed", d.Fix)
	}
	if d := findDiag(t, diags, "checks.jobs.lint.needs[0]"); !strings.Contains(d.Message, "cannot need itself") {
		t.Errorf("self-need diagnostic = %+v", d)
	}
}

func TestNeedsCycle(t *testing.T) {
	_, diags := parseString(t, readFixture(t, "invalid_needs.yml"), ParseOptions{})
	var cycles []Diagnostic
	for _, d := range diags {
		if strings.HasPrefix(d.Message, "cycle: ") {
			cycles = append(cycles, d)
		}
	}
	if len(cycles) != 1 {
		t.Fatalf("got %d cycle diagnostics, want 1:\n%s", len(cycles), diags.Format("test.yml"))
	}
	if d := cycles[0]; d.Message != "cycle: a -> b -> c -> a" || d.Path != "checks.jobs.a.needs[0]" {
		t.Errorf("cycle diagnostic = %+v", d)
	}

	_, diags = parseString(t, "version: 1\nchecks:\n  jobs:\n    b:\n      run: echo b\n      needs: [a]\n    a:\n      run: echo a\n      needs: [b]\n", ParseOptions{})
	if len(diags) != 1 || !strings.Contains(diags[0].Message, "cycle: a -> b -> a") {
		t.Errorf("two-job cycle diagnostics:\n%s", diags.Format("test.yml"))
	}
}

const trustAll = "version: 1\nchecks:\n  trust: all\n  jobs:\n    test:\n      run: go test ./...\n"

const trustAllWithDeploy = trustAll + "deployments:\n  production:\n    on:\n      push:\n        branch: main\n"

func TestTrustAllRefusedShared(t *testing.T) {
	_, diags := parseString(t, trustAll, ParseOptions{})
	d := findDiag(t, diags, "checks.trust")
	if d.Message != "trust: all is refused on the shared hub; it runs untrusted fork code with your runner's network" ||
		d.Fix != "use trust: approve, or self-host the hub without deployments" || d.Line != 3 {
		t.Errorf("diagnostic = %+v", d)
	}
}

func TestTrustAllAllowedSelfHostedNoDeploy(t *testing.T) {
	cfg, diags := parseString(t, trustAll, ParseOptions{SelfHosted: true})
	if len(diags) > 0 {
		t.Fatalf("unexpected diagnostics:\n%s", diags.Format("test.yml"))
	}
	if cfg.Checks().Trust != "all" {
		t.Errorf("trust = %q, want all", cfg.Checks().Trust)
	}
}

func TestTrustAllRefusedSelfHostedWithDeploy(t *testing.T) {
	_, diags := parseString(t, trustAllWithDeploy, ParseOptions{SelfHosted: true})
	if d := findDiag(t, diags, "checks.trust"); d.Severity != SeverityError {
		t.Errorf("diagnostic = %+v, want an error", d)
	}
}

func TestEgressRejectsIP(t *testing.T) {
	for _, entry := range []string{"10.0.0.1", "192.168.1.10:443", "::1", "[::1]", "2001:db8::1", "[2001:db8::1]:443"} {
		t.Run(entry, func(t *testing.T) {
			_, diags := parseString(t, oneJob+"  egress:\n    - "+strconv.Quote(entry)+"\n", ParseOptions{})
			if len(diags) != 1 {
				t.Fatalf("got %d diagnostics, want 1:\n%s", len(diags), diags.Format("test.yml"))
			}
			d := diags[0]
			if d.Path != "checks.egress[0]" || d.Line != 7 || d.Severity != SeverityError ||
				d.Message != "IP literal "+strconv.Quote(entry)+" is not allowed; egress takes host names" {
				t.Errorf("diagnostic = %+v", d)
			}
		})
	}
}

func TestRedactInvalidRegex(t *testing.T) {
	_, diags := parseString(t, readFixture(t, "invalid_redact.yml"), ParseOptions{})
	if len(diags) != 2 {
		t.Fatalf("diagnostics:\n%s", diags.Format("test.yml"))
	}
	for i, want := range []struct{ path, msg string }{
		{"redact[1]", "invalid or unsupported Perl syntax"},
		{"redact[2]", "missing closing )"},
	} {
		if d := diags[i]; d.Path != want.path || !strings.Contains(d.Message, want.msg) || d.Line != 8+i {
			t.Errorf("diagnostic %d = %+v, want %s at %s", i, d, want.msg, want.path)
		}
	}
}

func deployment(strategy, url string) string {
	s := oneJob + "deployments:\n  production:\n    on:\n      push:\n        branch: main\n"
	if strategy != "" {
		s += "    strategy: " + strategy + "\n"
	}
	return s + "    health:\n      url: " + url + "\n"
}

func TestHealthURLMustBeLocal(t *testing.T) {
	for url, want := range map[string]string{
		"http://example.com:8000/health":   "must point at 127.0.0.1 or localhost",
		"http://10.0.0.5:8000/health":      "must point at 127.0.0.1 or localhost",
		"https://127.0.0.1:8000/health":    "must use http",
		"http://127.0.0.1/health":          "needs an explicit port",
		"http://localhost:0/health":        "out of range",
		"http://127.0.0.1:8000/{port}":     "may only stand for the port",
		"127.0.0.1:8000/health":            "not a valid URL",
		"http://127.0.0.1:8000/health":     "",
		"http://localhost:8000/health?x=1": "",
	} {
		_, diags := parseString(t, deployment("restart", url), ParseOptions{})
		if want == "" {
			if len(diags) > 0 {
				t.Errorf("%s: unexpected diagnostics:\n%s", url, diags.Format("test.yml"))
			}
			continue
		}
		if d := findDiag(t, diags, "deployments.production.health.url"); !strings.Contains(d.Message, want) {
			t.Errorf("%s: message %q, want %q", url, d.Message, want)
		}
	}
}

func TestHealthPortPlaceholderOnlyBluegreen(t *testing.T) {
	const url = "http://127.0.0.1:{port}/health"
	if _, diags := parseString(t, deployment("compose-bluegreen", url), ParseOptions{}); len(diags) > 0 {
		t.Errorf("compose-bluegreen: unexpected diagnostics:\n%s", diags.Format("test.yml"))
	}
	for _, strategy := range []string{"restart", ""} {
		_, diags := parseString(t, deployment(strategy, url), ParseOptions{})
		if d := findDiag(t, diags, "deployments.production.health.url"); !strings.Contains(d.Message, "only filled in by strategy: compose-bluegreen") {
			t.Errorf("strategy %q: diagnostic = %+v", strategy, d)
		}
	}
}

func TestEnvFileWritableWarns(t *testing.T) {
	const file = "/etc/zeroci/production.env"
	src := oneJob + "deployments:\n  production:\n    on:\n      push:\n        branch: main\n    env_file: " + file + "\n"
	for _, tc := range []struct {
		name string
		info fs.FileInfo
		err  error
		want []string
	}{
		{"root 0600", fakeInfo{mode: 0o600, sys: &syscall.Stat_t{Uid: 0}}, nil, nil},
		{"group writable", fakeInfo{mode: 0o620, sys: &syscall.Stat_t{Uid: 0}}, nil, []string{"writable by group or others (mode 0620)"}},
		{"other writable", fakeInfo{mode: 0o602, sys: &syscall.Stat_t{Uid: 0}}, nil, []string{"writable by group or others"}},
		{"not root", fakeInfo{mode: 0o600, sys: &syscall.Stat_t{Uid: 1000}}, nil, []string{"owned by uid 1000, not root"}},
		{"missing", nil, fs.ErrNotExist, []string{"does not exist on this machine"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var asked string
			stat := func(name string) (fs.FileInfo, error) {
				asked = name
				return tc.info, tc.err
			}
			cfg, diags := Parse([]byte(src), ParseOptions{Stat: stat})
			if asked != file {
				t.Errorf("Stat called with %q, want %q", asked, file)
			}
			if cfg == nil {
				t.Fatalf("warnings rejected the config:\n%s", diags.Format("test.yml"))
			}
			if len(diags) != len(tc.want) {
				t.Fatalf("got %d diagnostics, want %d:\n%s", len(diags), len(tc.want), diags.Format("test.yml"))
			}
			for i, want := range tc.want {
				d := diags[i]
				if d.Severity != SeverityWarning || d.Path != "deployments.production.env_file" || !strings.Contains(d.Message, want) {
					t.Errorf("diagnostic = %+v, want a warning containing %q", d, want)
				}
			}
		})
	}
}

func TestEnvFileLookedUpInFS(t *testing.T) {
	src := oneJob + "deployments:\n  production:\n    on:\n      push:\n        branch: main\n    env_file: /etc/app.env\n"
	fsys := fstest.MapFS{"etc/app.env": {Mode: 0o666}}
	_, diags := Parse([]byte(src), ParseOptions{FS: fsys})
	if len(diags) != 1 || !strings.Contains(diags[0].Message, "writable by group or others (mode 0666)") {
		t.Errorf("diagnostics:\n%s", diags.Format("test.yml"))
	}
}
