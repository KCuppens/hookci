package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
)

func runValidate(_ context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("validate", flag.ContinueOnError)
	fs.SetOutput(stderr)
	selfHosted := fs.Bool("self-hosted", false, "validate for a self-hosted hub, where trust: all is allowed without deployments")
	asJSON := fs.Bool("json", false, "print the diagnostics as a JSON array")
	fs.Usage = func() {
		fmt.Fprintln(stdout, "Usage: zeroci validate [flags] [path]")
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Check a zeroci configuration file (default .zeroci.yml) against the schema and semantic rules.")
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Flags:")
		fs.SetOutput(stdout)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		return ExitUsage
	}
	if fs.NArg() > 1 {
		fmt.Fprintln(stderr, "zeroci: validate takes at most one path")
		return ExitUsage
	}
	path := ".zeroci.yml"
	if fs.NArg() == 1 {
		path = fs.Arg(0)
	}

	cfg, diags, err := config.Load(path, config.ParseOptions{SelfHosted: *selfHosted})
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitInternal
	}

	if *asJSON {
		if diags == nil {
			diags = config.Diagnostics{}
		}
		out, err := json.MarshalIndent(diags, "", "  ")
		if err != nil {
			fmt.Fprintf(stderr, "zeroci: encode diagnostics: %v\n", err)
			return ExitInternal
		}
		fmt.Fprintf(stdout, "%s\n", out)
	} else {
		fmt.Fprint(stderr, diags.Format(path))
	}
	if diags.HasErrors() {
		return ExitUsage
	}
	if !*asJSON {
		fmt.Fprintf(stdout, "ok: %s (%d jobs)\n", path, len(cfg.Checks().Jobs))
	}
	return ExitOK
}
