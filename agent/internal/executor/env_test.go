package executor

import (
	"slices"
	"strings"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/store"
)

func pushInput() EnvInput {
	return EnvInput{
		Run: store.Run{ID: "01run", SHA: "abc123", Ref: "refs/heads/main", Event: "push", BaseSHA: "base1"},
		Job: "lint",
		Dir: RunDir{Root: "/state/runs/01run"},
	}
}

func envKeys(env []string) []string {
	keys := make([]string, len(env))
	for i, kv := range env {
		keys[i], _, _ = strings.Cut(kv, "=")
	}
	return keys
}

func envValue(env []string, key string) (string, bool) {
	for _, kv := range env {
		if k, v, _ := strings.Cut(kv, "="); k == key {
			return v, true
		}
	}
	return "", false
}

func TestBuildJobEnvExactKeys(t *testing.T) {
	env := BuildJobEnv(pushInput())
	want := []string{"CI", "HOME", "HOOKCI", "HOOKCI_EVENT", "HOOKCI_JOB", "HOOKCI_REF", "HOOKCI_RUN_ID", "HOOKCI_SHA", "LANG", "PATH", "TMPDIR"}
	if got := envKeys(env); !slices.Equal(got, want) {
		t.Fatalf("keys = %v, want %v", got, want)
	}
	for key, want := range map[string]string{
		"PATH":          JobPATH,
		"HOME":          "/state/runs/01run/home",
		"TMPDIR":        "/state/runs/01run/tmp",
		"LANG":          "C.UTF-8",
		"CI":            "true",
		"HOOKCI":        "1",
		"HOOKCI_RUN_ID": "01run",
		"HOOKCI_JOB":    "lint",
		"HOOKCI_SHA":    "abc123",
		"HOOKCI_REF":    "refs/heads/main",
		"HOOKCI_EVENT":  "push",
	} {
		if got, _ := envValue(env, key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}

	in := pushInput()
	in.ProxyEnv = []string{"HTTP_PROXY=http://127.0.0.1:1"}
	in.ServiceEnv = []string{"DATABASE_URL=postgres:///x"}
	env = BuildJobEnv(in)
	for _, key := range []string{"HTTP_PROXY", "DATABASE_URL"} {
		if _, ok := envValue(env, key); !ok {
			t.Errorf("proxy or service env %s missing: %v", key, env)
		}
	}
}

func TestBuildJobEnvBaseSHAOnlyForPR(t *testing.T) {
	if _, ok := envValue(BuildJobEnv(pushInput()), "HOOKCI_BASE_SHA"); ok {
		t.Fatal("push run has HOOKCI_BASE_SHA")
	}
	in := pushInput()
	pr := 7
	in.Run.PR = &pr
	in.Run.Event = "pull_request"
	if got, ok := envValue(BuildJobEnv(in), "HOOKCI_BASE_SHA"); !ok || got != "base1" {
		t.Fatalf("HOOKCI_BASE_SHA = %q, %v; want base1", got, ok)
	}
}

func TestBuildJobEnvNoSecrets(t *testing.T) {
	t.Setenv("DOCKER_HOST", "unix:///var/run/docker.sock")
	t.Setenv("SSH_AUTH_SOCK", "/tmp/ssh-agent.sock")
	t.Setenv("DATABASE_PASSWORD", "hunter2-prod-secret")
	for _, inherit := range []bool{false, true} {
		in := pushInput()
		in.InheritPATH = inherit
		env := BuildJobEnv(in)
		for _, kv := range env {
			if strings.HasPrefix(kv, "DOCKER_HOST=") || strings.HasPrefix(kv, "SSH_AUTH_SOCK=") || strings.Contains(kv, "hunter2-prod-secret") {
				t.Errorf("InheritPATH=%v: agent env leaked: %s", inherit, kv)
			}
		}
	}
}

func TestBuildJobEnvInheritPATH(t *testing.T) {
	t.Setenv("PATH", "/opt/toolchain/bin:/usr/bin")
	if got, _ := envValue(BuildJobEnv(pushInput()), "PATH"); got != JobPATH {
		t.Errorf("PATH without InheritPATH = %q, want %q", got, JobPATH)
	}
	in := pushInput()
	in.InheritPATH = true
	if got, _ := envValue(BuildJobEnv(in), "PATH"); got != "/opt/toolchain/bin:/usr/bin" {
		t.Errorf("PATH with InheritPATH = %q, want the agent's PATH", got)
	}
}
