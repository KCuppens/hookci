package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"strconv"

	"github.com/KCuppens/zerocideploy/agent/internal/control"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
)

// cmdRetry asks the running agent to retry a Failed or Interrupted deploy
// run under the same run id with the next attempt.
func cmdRetry(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("retry", flag.ContinueOnError)
	fs.SetOutput(stderr)
	stateDir := fs.String("state-dir", d.Globals.StateDir, "agent state directory, as given to zeroci connect")
	installation := fs.Int64("installation", 0, "use the agent of this installation in "+defaultStateRoot+"/<ID>")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: zeroci [global flags] retry <run_id> [--state-dir DIR | --installation ID]")
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
	if *installation < 0 {
		fmt.Fprintln(stderr, "zeroci: --installation must be a positive installation id")
		return ExitUsage
	}
	if *installation > 0 {
		*stateDir = filepath.Join(defaultStateRoot, strconv.FormatInt(*installation, 10))
	}

	var rep deploy.RetryReply
	err = control.Call(ctx, *stateDir, deploy.RetryOp, deploy.RetryRequest{RunID: pos[0]}, &rep)
	if errors.Is(err, control.ErrNotRunning) {
		fmt.Fprintln(stderr, "zeroci: agent is not running; start it with systemctl start zeroci-agent@<installation>")
		return ExitRunFailed
	}
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitRunFailed
	}
	fmt.Fprintf(stdout, "queued retry of %s (attempt %d)\n", rep.RunID, rep.Attempt)
	return ExitOK
}
