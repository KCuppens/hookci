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

// scriptDeploy is a minimal valid deployments section.
const scriptDeploy = "deployments:\n  production:\n    on:\n      push: main\n    strategy: script\n    run: ./deploy.sh\n"

const trustAllWithDeploy = trustAll + scriptDeploy

func TestTrustAllRefusedShared(t *testing.T) {
	_, diags := parseString(t, trustAll, ParseOptions{})
	d := findDiag(t, diags, "checks.trust")
	if d.Message != "trust: all is refused on the shared hub; it runs untrusted fork code with your runner's network" ||
		d.Fix != "use trust: collaborators, or self-host the hub without deployments" || d.Line != 3 {
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

func TestDeclaredPolicy(t *testing.T) {
	tests := []struct {
		name string
		data string
		want Policy
		ok   bool
	}{
		{"trust all the semantic checks refuse", trustAllWithDeploy, Policy{Trust: ChecksTrustAll, HasDeployments: true}, true},
		{"trust all without deployments", trustAll, Policy{Trust: ChecksTrustAll}, true},
		{"default trust", oneJob, Policy{Trust: ChecksTrustCollaborators}, true},
		{"no checks", "version: 1\n" + scriptDeploy, Policy{Trust: ChecksTrustCollaborators, HasDeployments: true}, true},
		{"schema error", "version: 1\nchecks:\n  trust: approve\n", Policy{}, false},
		{"invalid YAML", "version: [1\n", Policy{}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := DeclaredPolicy([]byte(tc.data))
			if got != tc.want || ok != tc.ok {
				t.Errorf("DeclaredPolicy = %+v, %v; want %+v, %v", got, ok, tc.want, tc.ok)
			}
		})
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

func TestEnvFileWritableWarns(t *testing.T) {
	const file = "/etc/zeroci/production.env"
	src := oneJob + scriptDeploy + "    env_file: " + file + "\n"
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
	src := oneJob + scriptDeploy + "    env_file: /etc/app.env\n"
	fsys := fstest.MapFS{"etc/app.env": {Mode: 0o666}}
	_, diags := Parse([]byte(src), ParseOptions{FS: fsys})
	if len(diags) != 1 || !strings.Contains(diags[0].Message, "writable by group or others (mode 0666)") {
		t.Errorf("diagnostics:\n%s", diags.Format("test.yml"))
	}
}
