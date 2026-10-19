package config

import (
	"reflect"
	"testing"
	"testing/fstest"
	"time"
)

func TestEnvFilesCollected(t *testing.T) {
	src := oneJob + "deployments:\n" +
		"  staging:\n    on:\n      push:\n        branch: dev\n    env_file: /etc/b.env\n" +
		"  production:\n    on:\n      push:\n        branch: main\n    env_file: /etc/a.env\n"
	fsys := fstest.MapFS{"etc/a.env": {Mode: 0o600}, "etc/b.env": {Mode: 0o600}}
	cfg, _ := Parse([]byte(src), ParseOptions{FS: fsys})
	if cfg == nil || cfg.Checks() == nil {
		t.Fatal("Parse returned no checks")
	}
	if got, want := cfg.Checks().EnvFiles, []string{"/etc/a.env", "/etc/b.env"}; !reflect.DeepEqual(got, want) {
		t.Errorf("EnvFiles = %v, want %v", got, want)
	}
}

func TestJobsTopoSorted(t *testing.T) {
	src := `version: 1
checks:
  jobs:
    deploy-check:
      run: echo deploy
      needs: [unit, e2e]
    unit:
      run: npm test
      needs: [lint, build]
    e2e:
      run: npm run e2e
      needs: [build]
    lint:
      run: npm run lint
    build:
      run: npm run build
    docs:
      run: npm run docs
`
	cfg, diags := parseString(t, src, ParseOptions{})
	if len(diags) > 0 {
		t.Fatalf("unexpected diagnostics:\n%s", diags.Format("test.yml"))
	}
	var got []string
	for _, j := range cfg.Checks().Jobs {
		got = append(got, j.Name)
	}
	want := []string{"build", "docs", "e2e", "lint", "unit", "deploy-check"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("job order = %v, want %v", got, want)
	}
	if needs := cfg.Checks().Jobs[5].Needs; !reflect.DeepEqual(needs, []string{"unit", "e2e"}) {
		t.Errorf("needs = %v, want them in file order", needs)
	}
}

func TestJobLimitsOverride(t *testing.T) {
	src := `version: 1
checks:
  limits:
    cpus: 4
    memory: 8G
    timeout: 20m
  jobs:
    inherit:
      run: make
    partial:
      run: make test
      limits:
        memory: 512M
        tasks: 64
    timed:
      run: make e2e
      limits:
        cpus: 1.5
        timeout: 30m
      timeout: 45s
`
	cfg, diags := parseString(t, src, ParseOptions{})
	if len(diags) > 0 {
		t.Fatalf("unexpected diagnostics:\n%s", diags.Format("test.yml"))
	}
	checkLevel := ResolvedLimits{CPUs: 4, MemoryBytes: 8 << 30, Tasks: 512, Timeout: 20 * time.Minute}
	if got := cfg.Checks().Limits; got != checkLevel {
		t.Errorf("check limits = %+v, want %+v", got, checkLevel)
	}
	want := map[string]ResolvedLimits{
		"inherit": checkLevel,
		"partial": {CPUs: 4, MemoryBytes: 512 << 20, Tasks: 64, Timeout: 20 * time.Minute},
		"timed":   {CPUs: 1.5, MemoryBytes: 8 << 30, Tasks: 512, Timeout: 45 * time.Second},
	}
	for _, j := range cfg.Checks().Jobs {
		if j.Limits != want[j.Name] {
			t.Errorf("%s limits = %+v, want %+v", j.Name, j.Limits, want[j.Name])
		}
	}
}
