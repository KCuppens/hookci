package deploy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"slices"
	"strconv"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/redact"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// DeployUser is the account deploy units run as. It may use docker and
// localhost, which the PR sandbox user zeroci-run may not.
const DeployUser = "zeroci-deploy"

// stopTimeout bounds the systemctl stop after a canceled step.
const stopTimeout = 30 * time.Second

// ErrUntrustedDeploy refuses an executor to a run that is not trusted.
var ErrUntrustedDeploy = errors.New("deploy: run is not trusted")

// ExecutorDeps are what NewExecutorForRun builds an executor from.
type ExecutorDeps struct {
	Runner execx.Runner
	// Redactor masks the run log; the env_file values are added to it.
	Redactor *redact.Redactor
}

// NewExecutorForRun returns the executor for a deploy run: a UnitExecutor
// running as DeployUser with the deployment's root-owned env_file loaded.
// It returns ErrUntrustedDeploy unless trusted is true (a push to a
// protected ref).
func NewExecutorForRun(run store.DeployRun, trusted bool, cfg config.Deployment, deps ExecutorDeps) (Executor, error) {
	if !trusted {
		return nil, ErrUntrustedDeploy
	}
	var env map[string]string
	if cfg.EnvFile != nil {
		var err error
		if env, err = LoadEnvFile(*cfg.EnvFile, true); err != nil {
			return nil, fmt.Errorf("deployments.%s.%w", run.Env, err)
		}
	}
	return &UnitExecutor{
		Runner:   deps.Runner,
		RunID:    run.RunID,
		User:     DeployUser,
		EnvFile:  env,
		Redactor: deps.Redactor,
	}, nil
}

// UnitName returns the transient unit name of a run's deploy commands,
// "zeroci-run-<run_id>-deploy".
func UnitName(runID string) string {
	return isolation.UnitName(runID, "deploy")
}

// UnitExecutor runs deploy commands as transient systemd units outside the
// PR sandbox: no private network, no address deny list, so the command can
// reach docker and localhost. EnvFile and the step env reach the unit only
// through --setenv, never through a file.
type UnitExecutor struct {
	Runner   execx.Runner
	RunID    string
	User     string // DeployUser
	EnvFile  map[string]string
	Redactor *redact.Redactor // nil masks only the built-in patterns
}

// Run runs argv in the run's deploy unit. Stdout and stderr pass through the
// redactor, with every EnvFile value masked, before reaching opts.Stdout and
// opts.Stderr. A failure names the step and, for a non-zero exit, the code;
// it never carries command output.
func (u *UnitExecutor) Run(ctx context.Context, step string, argv []string, opts ExecOpts) error {
	if len(argv) == 0 {
		return fmt.Errorf("deploy: step %s: empty command", step)
	}
	red := u.redactor()
	stdout := red.Writer(orDiscard(opts.Stdout))
	stderr := red.Writer(orDiscard(opts.Stderr))
	unit := UnitName(u.RunID)
	err := u.Runner.Run(ctx, execx.Cmd{Name: "systemd-run", Args: u.args(unit, argv, opts), Stdout: stdout, Stderr: stderr})
	_ = stdout.Close()
	_ = stderr.Close()
	if ctx.Err() != nil {
		// Killing systemd-run does not stop the unit, so stop it explicitly.
		stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), stopTimeout)
		_ = (&isolation.Systemd{Runner: u.Runner}).Stop(stopCtx, unit)
		cancel()
	}
	if err == nil {
		return nil
	}
	if exitErr, ok := errors.AsType[*execx.ExitError](err); ok {
		return fmt.Errorf("deploy: step %s: exit code %d", step, exitErr.Code)
	}
	return fmt.Errorf("deploy: step %s: %w", step, err)
}

// redactor returns u.Redactor extended with every EnvFile value.
func (u *UnitExecutor) redactor() *redact.Redactor {
	base := u.Redactor
	if base == nil {
		base, _ = redact.New(nil, nil)
	}
	return base.With(slices.Collect(maps.Values(u.EnvFile)))
}

// args builds the systemd-run arguments (after the binary name).
func (u *UnitExecutor) args(unit string, argv []string, opts ExecOpts) []string {
	user := u.User
	if user == "" {
		user = DeployUser
	}
	maxSec := "infinity"
	if opts.Timeout > 0 {
		maxSec = strconv.FormatInt(int64((opts.Timeout+time.Second-1)/time.Second), 10)
	}
	args := []string{
		"--unit=" + unit,
		"--uid=" + user,
		"--gid=" + user,
		"--pipe", "--wait", "--collect", "--quiet",
		"--property=RuntimeMaxSec=" + maxSec,
	}
	env := maps.Clone(u.EnvFile)
	if env == nil {
		env = make(map[string]string, len(opts.Env))
	}
	maps.Copy(env, opts.Env)
	for _, k := range slices.Sorted(maps.Keys(env)) {
		args = append(args, "--setenv="+k+"="+env[k])
	}
	if opts.Dir != "" {
		args = append(args, "--working-directory="+opts.Dir)
	}
	args = append(args, "--")
	return append(args, argv...)
}

func orDiscard(w io.Writer) io.Writer {
	if w == nil {
		return io.Discard
	}
	return w
}
