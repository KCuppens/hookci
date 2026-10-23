package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"

	"github.com/KCuppens/hookci/agent/internal/control"
	"github.com/KCuppens/hookci/agent/internal/deploy"
)

// cmdRetry asks the running agent to retry a Failed or Interrupted deploy
// run under the same run id with the next attempt.
func cmdRetry(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("retry", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dirFlags := addStateDirFlags(fs, d)
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: hookci [global flags] retry <run_id> [--state-dir DIR | --installation ID]")
		fmt.Fprintln(stderr)
		fmt.Fprintln(stderr, "Retry a Failed or Interrupted deploy run.")
		fs.PrintDefaults()
	}
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		return ExitUsage
	}
	if len(pos) != 1 || pos[0] == "" {
		fs.Usage()
		return ExitUsage
	}
	stateDir, ok := dirFlags.resolve(stderr)
	if !ok {
		return ExitUsage
	}

	var rep deploy.RetryReply
	err = control.Call(ctx, stateDir, deploy.RetryOp, deploy.RetryRequest{RunID: pos[0]}, &rep)
	if errors.Is(err, control.ErrNotRunning) {
		fmt.Fprintln(stderr, "hookci: agent is not running; start it with systemctl start hookci-agent@<installation>")
		return ExitRunFailed
	}
	if err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitRunFailed
	}
	fmt.Fprintf(stdout, "queued retry of %s (attempt %d)\n", rep.RunID, rep.Attempt)
	return ExitOK
}
