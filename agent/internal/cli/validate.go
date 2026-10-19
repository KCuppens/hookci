package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
)

func runValidate(_ context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("validate", flag.ContinueOnError)
	fs.SetOutput(stderr)

	var filePath string
	fs.StringVar(&filePath, "f", ".zeroci.yml", "path to config file")
	fs.StringVar(&filePath, "file", ".zeroci.yml", "path to config file")

	fs.Usage = func() {
		fmt.Fprintln(stdout, "Usage: zeroci validate [flags] [path]")
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Validate a zeroci configuration file against schema and semantic rules.")
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

	target := filePath
	if fs.NArg() > 0 {
		target = fs.Arg(0)
	}

	cfg, err := config.Load(target)
	if err != nil {
		fmt.Fprintf(stderr, "%s: invalid configuration: %v\n", target, err)
		return ExitUsage
	}

	fmt.Fprintf(stdout, "%s: valid configuration (%d check jobs)\n", target, len(cfg.Checks))
	return ExitOK
}
