package source

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"syscall"

	"github.com/KCuppens/hookci/agent/internal/execx"
)

// stderrLimit bounds how much of git's stderr is kept in an error.
const stderrLimit = 2048

// hardenedArgs disable hooks, fsmonitor, implicit submodule recursion and
// credential helpers, keep file:// remotes to explicit use, and abort an HTTP
// transfer that stays under 1 KB/s for 60 s so a stalled remote cannot hold a run.
var hardenedArgs = []string{
	"-c", "core.hooksPath=/dev/null",
	"-c", "core.fsmonitor=false",
	"-c", "protocol.file.allow=user",
	"-c", "submodule.recurse=false",
	"-c", "credential.helper=",
	"-c", "http.lowSpeedLimit=1000",
	"-c", "http.lowSpeedTime=60",
}

// Git runs git through an execx.Runner with hardened flags.
type Git struct {
	Runner execx.Runner
	Bin    string // default "git"
}

// Args prefixes args with the hardened -c flags.
func (g Git) Args(args ...string) []string {
	out := make([]string, 0, len(hardenedArgs)+len(args))
	out = append(out, hardenedArgs...)
	return append(out, args...)
}

// SafeGitEnv returns the only environment git ever sees: system and global
// config disabled, no terminal prompt, no LFS smudge, LANG=C, the caller's
// PATH, HOME=home, then extra. No other inherited variable is passed on.
func SafeGitEnv(home string, extra ...string) []string {
	env := []string{
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_LFS_SKIP_SMUDGE=1",
		"LANG=C",
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + home,
	}
	return append(env, extra...)
}

// Run executes git with the hardened args in dir, with exactly env, as cred
// when non-nil. It returns stdout. A non-zero exit becomes an error carrying
// git's trimmed stderr that unwraps to *execx.ExitError.
func (g Git) Run(ctx context.Context, dir string, env []string, cred *syscall.Credential, args ...string) ([]byte, error) {
	bin := g.Bin
	if bin == "" {
		bin = "git"
	}
	var stdout bytes.Buffer
	err := g.Runner.Run(ctx, execx.Cmd{
		Name:       bin,
		Args:       g.Args(args...),
		Dir:        dir,
		Env:        env,
		Stdout:     &stdout,
		Credential: cred,
	})
	if err == nil {
		return stdout.Bytes(), nil
	}
	var exitErr *execx.ExitError
	if errors.As(err, &exitErr) {
		return stdout.Bytes(), &gitError{args: args, exit: exitErr}
	}
	return stdout.Bytes(), fmt.Errorf("source: git %s: %w", strings.Join(args, " "), err)
}

type gitError struct {
	args []string
	exit *execx.ExitError
}

func (e *gitError) Error() string {
	stderr := strings.TrimSpace(e.exit.Stderr)
	if len(stderr) > stderrLimit {
		stderr = stderr[len(stderr)-stderrLimit:]
	}
	return fmt.Sprintf("source: git %s: exit status %d: %s", strings.Join(e.args, " "), e.exit.Code, stderr)
}

func (e *gitError) Unwrap() error { return e.exit }
