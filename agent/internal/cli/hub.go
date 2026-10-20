package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"

	"github.com/KCuppens/zerocideploy/agent/internal/version"
)

// Stdio is the terminal a passthrough command inherits, so its prompts work.
type Stdio struct {
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

// HubDeps are what `zeroci hub` needs to run the zeroci-hub CLI through npx.
type HubDeps struct {
	LookPath func(string) (string, error)
	Run      func(ctx context.Context, name string, args []string, stdio Stdio) error
	// Version is this zeroci's version; it picks the zeroci-hub release.
	Version string
}

const hubUsage = `usage: zeroci hub setup|upgrade [zeroci-hub options]

Run zeroci-hub setup or upgrade for this zeroci version through npx. All
arguments after the subcommand go to zeroci-hub; see zeroci hub setup --help.
`

const errHubNeedsNode = "zeroci hub needs Node.js 20+ and npx on this machine (it runs wrangler against your Cloudflare account); install Node or run it from your laptop"

func defaultHubDeps() HubDeps {
	return HubDeps{
		LookPath: exec.LookPath,
		Run: func(ctx context.Context, name string, args []string, stdio Stdio) error {
			cmd := exec.CommandContext(ctx, name, args...)
			cmd.Stdin, cmd.Stdout, cmd.Stderr = stdio.Stdin, stdio.Stdout, stdio.Stderr
			return cmd.Run()
		},
		Version: version.Version,
	}
}

// hubArgv is the npx command line that runs zeroci-hub sub at the release
// matching version; a dev build runs the latest release.
func hubArgv(sub, version string, extra []string) []string {
	pkg := "zeroci-hub@latest"
	if v := strings.TrimPrefix(version, "v"); v != "" && v != "dev" {
		pkg = "zeroci-hub@" + v
	}
	return append([]string{"npx", "--yes", pkg, sub}, extra...)
}

// runHub runs zeroci-hub sub with extra through npx on stdio.
func runHub(ctx context.Context, d HubDeps, sub string, extra []string, stdio Stdio) error {
	if _, err := d.LookPath("npx"); err != nil {
		return errors.New(errHubNeedsNode)
	}
	argv := hubArgv(sub, d.Version, extra)
	return d.Run(ctx, argv[0], argv[1:], stdio)
}

// cmdHub passes setup and upgrade through to the zeroci-hub CLI. zeroci-hub
// reports its own failures, so its exit code is returned as is.
func cmdHub(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	if len(args) > 0 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Fprint(stdout, hubUsage)
		return ExitOK
	}
	if len(args) == 0 || (args[0] != "setup" && args[0] != "upgrade") {
		fmt.Fprint(stderr, hubUsage)
		return ExitUsage
	}
	err := runHub(ctx, d.Hub, args[0], args[1:], Stdio{Stdin: d.Stdin, Stdout: stdout, Stderr: stderr})
	var exit *exec.ExitError
	switch {
	case err == nil:
		return ExitOK
	case errors.As(err, &exit) && exit.ExitCode() > 0:
		return exit.ExitCode()
	default:
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitRunFailed
	}
}
