package deploy

import (
	"bytes"
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/redact"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

func TestUnitExecutor_Argv(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("systemd-run", nil, execx.FakeResponse{})
	u := &UnitExecutor{Runner: fake, RunID: "r1", User: DeployUser, EnvFile: "/etc/zeroci/production.env"}
	err := u.Run(context.Background(), "build", []string{"docker", "compose", "build"}, ExecOpts{
		Dir: "/srv/app", Env: map[string]string{"IMAGE": "web:abc", "TOKEN": "override"}, Timeout: 90500 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(fake.Calls))
	}
	c := fake.Calls[0]
	if c.Name != "systemd-run" {
		t.Fatalf("binary = %q, want systemd-run", c.Name)
	}
	want := []string{
		"--unit=zeroci-run-r1-deploy", "--uid=zeroci-deploy", "--gid=zeroci-deploy",
		"--pipe", "--wait", "--collect", "--quiet", "--property=RuntimeMaxSec=91",
		"--property=EnvironmentFile=/etc/zeroci/production.env",
		"--setenv=IMAGE=web:abc", "--setenv=TOKEN=override",
		"--working-directory=/srv/app", "--", "docker", "compose", "build",
	}
	if !slices.Equal(c.Args, want) {
		t.Errorf("args = %q\nwant   %q", c.Args, want)
	}
	for _, a := range c.Args {
		if strings.Contains(a, "PrivateNetwork") || strings.Contains(a, "IPAddressDeny") {
			t.Errorf("argv carries sandbox property %q", a)
		}
	}
	if c.Env != nil {
		t.Errorf("Cmd.Env = %q, want env only through --setenv", c.Env)
	}
}

func TestUnitExecutor_NoTimeoutIsInfinity(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("systemd-run", nil, execx.FakeResponse{})
	u := &UnitExecutor{Runner: fake, RunID: "r1"}
	if err := u.Run(context.Background(), "build", []string{"true"}, ExecOpts{}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	args := fake.Calls[0].Args
	if !slices.Contains(args, "--property=RuntimeMaxSec=infinity") || !slices.Contains(args, "--uid=zeroci-deploy") {
		t.Errorf("args = %q", args)
	}
	if slices.ContainsFunc(args, func(a string) bool { return strings.HasPrefix(a, "--working-directory") }) {
		t.Errorf("args = %q, want no working directory without Dir", args)
	}
}

func TestUnitExecutor_RedactsEnvValues(t *testing.T) {
	const secret = "hunter2-db-password"
	fake := &execx.Fake{}
	fake.On("systemd-run", nil, execx.FakeResponse{
		Stdout: "connecting with " + secret + "\n",
		Stderr: "auth " + secret + " failed\n",
	})
	base, _ := redact.New(nil, nil)
	u := &UnitExecutor{Runner: fake, RunID: "r1", Secrets: []string{secret, "abc"}, Redactor: base}
	var log bytes.Buffer
	if err := u.Run(context.Background(), "migrate", []string{"sh", "-c", "echo $DB_PASSWORD"}, ExecOpts{Stdout: &log, Stderr: &log}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	got := log.String()
	if strings.Contains(got, secret) {
		t.Errorf("log %q leaks the env_file secret", got)
	}
	want := "connecting with " + redact.Mask + "\nauth " + redact.Mask + " failed\n"
	if got != want {
		t.Errorf("log = %q, want %q", got, want)
	}
	if base.Line(secret) != secret {
		t.Error("the shared redactor was changed; env values belong to this executor only")
	}
}

func TestUnitExecutor_ErrorNamesStepAndCode(t *testing.T) {
	const secret = "hunter2-db-password"
	fake := &execx.Fake{}
	fake.On("systemd-run", nil, execx.FakeResponse{Stderr: "bad " + secret, Code: 3})
	u := &UnitExecutor{Runner: fake, RunID: "r1", Secrets: []string{secret}}
	err := u.Run(context.Background(), "migrate", []string{"false"}, ExecOpts{})
	if err == nil || err.Error() != "deploy: step migrate: exit code 3" {
		t.Errorf("err = %v, want step and exit code without output", err)
	}
}

func TestUnitExecutor_CancelStopsUnit(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	fake := &execx.Fake{}
	fake.On("systemd-run", nil, execx.FakeResponse{Fn: func(execx.Cmd) error {
		cancel()
		return context.Canceled
	}})
	fake.On("systemctl", []string{"stop", "zeroci-run-r1-deploy.service"}, execx.FakeResponse{})
	u := &UnitExecutor{Runner: fake, RunID: "r1"}
	if err := u.Run(ctx, "start", []string{"sleep", "60"}, ExecOpts{}); !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want context.Canceled", err)
	}
	if !fake.Called("systemctl", "stop", "zeroci-run-r1-deploy.service") {
		t.Error("cancel did not stop the deploy unit")
	}
}

func TestNewExecutor_UntrustedRefused(t *testing.T) {
	envFile := writeEnvFile(t, "TOKEN=secret\n")
	ex, err := NewExecutorForRun(store.DeployRun{RunID: "r1", Env: "production"}, false,
		config.Deployment{EnvFile: &envFile}, ExecutorDeps{Runner: &execx.Fake{}})
	if !errors.Is(err, ErrUntrustedDeploy) || ex != nil {
		t.Errorf("NewExecutorForRun = %v, %v; want nil, ErrUntrustedDeploy", ex, err)
	}
}

func TestNewExecutor_EnvFileByPathNotArgv(t *testing.T) {
	const secret = "secret-value"
	envFile := writeEnvFile(t, "TOKEN="+secret+"\n")
	stubStat(t, fakeInfo{mode: 0o600, uid: 0})
	fake := &execx.Fake{}
	fake.On("systemd-run", nil, execx.FakeResponse{Stdout: "token " + secret + "\n"})
	ex, err := NewExecutorForRun(store.DeployRun{RunID: "r1", Env: "production"}, true,
		config.Deployment{EnvFile: &envFile}, ExecutorDeps{Runner: fake})
	if err != nil {
		t.Fatalf("NewExecutorForRun: %v", err)
	}
	var log bytes.Buffer
	if err := ex.Run(context.Background(), "build", []string{"true"}, ExecOpts{Stdout: &log}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	args := fake.Calls[0].Args
	if !slices.Contains(args, "--property=EnvironmentFile="+envFile) || !slices.Contains(args, "--uid=zeroci-deploy") {
		t.Errorf("args = %q, want the env_file path and the deploy user", args)
	}
	for _, a := range args {
		if strings.Contains(a, secret) {
			t.Errorf("argv carries the env_file value: %q", a)
		}
	}
	if got := log.String(); strings.Contains(got, secret) {
		t.Errorf("log %q leaks the env_file value", got)
	}
}

func TestNewExecutor_NonRootEnvFileNamesDeployment(t *testing.T) {
	envFile := writeEnvFile(t, "TOKEN=secret\n")
	stubStat(t, fakeInfo{mode: 0o600, uid: 1000})
	_, err := NewExecutorForRun(store.DeployRun{RunID: "r1", Env: "production"}, true,
		config.Deployment{EnvFile: &envFile}, ExecutorDeps{Runner: &execx.Fake{}})
	want := "deployments.production.env_file: " + envFile + " must be owned by root with mode 0600"
	if err == nil || err.Error() != want {
		t.Errorf("err = %v, want %q", err, want)
	}
}
