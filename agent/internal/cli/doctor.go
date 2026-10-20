package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"path/filepath"
	"strings"

	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/doctor"
)

// cmdDoctor runs the host checks, then the deploy checks against the
// .hookci.yml of the checkout holding the working directory, and prints them
// as a table, or as a JSON array with --json. It exits 1 when any check
// fails.
func cmdDoctor(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	fs.SetOutput(stderr)
	hub := fs.String("hub", "", "hub base URL (default the paired hub, else "+defaultHubURL+")")
	stateRoot := fs.String("state-root", defaultStateRoot, "directory holding one state directory per installation")
	asJSON := fs.Bool("json", false, "print the results as a JSON array")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: hookci doctor [--hub URL] [--state-root DIR] [--json]")
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
	checks := append(doctor.Default(), doctor.DeployChecks(doctor.DeployCheckDeps{Repos: cwdRepos(d)})...)
	rs := append(doctor.Run(ctx, env, checks), doctor.ForkTrust(ctx, env)...)

	failed := false
	if *asJSON {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(rs); err != nil {
			fmt.Fprintf(stderr, "hookci: %v\n", err)
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

// cwdRepos returns the config of the checkout holding the working directory
// for the deploy checks: none outside a checkout or without a .hookci.yml,
// an error when the file does not load or validate.
func cwdRepos(d Deps) func(context.Context) ([]config.HookCIConfig, error) {
	return func(context.Context) ([]config.HookCIConfig, error) {
		wd, err := d.Getwd()
		if err != nil {
			return nil, fmt.Errorf("cli: doctor: %w", err)
		}
		top, _, err := gitCheckout(wd)
		if err != nil {
			return nil, nil
		}
		path := filepath.Join(top, ".hookci.yml")
		cfg, diags, err := config.Load(path, config.ParseOptions{})
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		if err != nil {
			return nil, fmt.Errorf("cli: doctor: %w", err)
		}
		for _, dg := range diags {
			if dg.Severity == config.SeverityError {
				return nil, fmt.Errorf("cli: doctor: %s: %s", path, config.ValidationError{Path: dg.Path, Msg: dg.Message, Fix: dg.Fix}.Error())
			}
		}
		return []config.HookCIConfig{cfg.HookCIConfig}, nil
	}
}
