package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/KCuppens/zerocideploy/agent/internal/doctor"
)

// cmdDoctor runs the host checks and prints them as a table, or as a JSON
// array with --json. It exits 1 when any check fails.
func cmdDoctor(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	fs.SetOutput(stderr)
	hub := fs.String("hub", "", "hub base URL (default the paired hub, else "+defaultHubURL+")")
	stateRoot := fs.String("state-root", defaultStateRoot, "directory holding one state directory per installation")
	asJSON := fs.Bool("json", false, "print the results as a JSON array")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: zeroci doctor [--hub URL] [--state-root DIR] [--json]")
		fmt.Fprintln(stderr)
		fmt.Fprintln(stderr, "Check this host and its path to the hub; exit 1 when a check fails.")
	}
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		return ExitUsage
	}
	if len(pos) != 0 {
		fs.Usage()
		return ExitUsage
	}

	env := d.Doctor(*stateRoot, strings.TrimRight(*hub, "/"))
	if env.HubOrigin == "" {
		env.HubOrigin = strings.TrimRight(doctor.PairedHub(env), "/")
	}
	if env.HubOrigin == "" {
		env.HubOrigin = defaultHubURL
	}
	rs := doctor.Run(ctx, env, doctor.Default())

	failed := false
	if *asJSON {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(rs); err != nil {
			fmt.Fprintf(stderr, "zeroci: %v\n", err)
			return ExitInternal
		}
		for _, r := range rs {
			failed = failed || r.Status == doctor.Fail
		}
	} else {
		failed = doctor.Render(stdout, rs)
	}
	if failed {
		return ExitRunFailed
	}
	return ExitOK
}
