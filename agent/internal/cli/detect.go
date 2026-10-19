package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"

	"github.com/KCuppens/zerocideploy/agent/internal/detect"
)

func runDetect(_ context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("detect", flag.ContinueOnError)
	fs.SetOutput(stderr)

	fs.Usage = func() {
		fmt.Fprintln(stdout, "Usage: zeroci detect [path]")
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Auto-detect project ecosystem and print inferred ZeroCI configuration.")
	}

	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		return ExitUsage
	}

	dir := "."
	if fs.NArg() > 0 {
		dir = fs.Arg(0)
	}

	res, err := detect.Detect(dir)
	if err != nil {
		if errors.Is(err, detect.ErrNoEcosystemDetected) {
			fmt.Fprintf(stderr, "zeroci: no supported project ecosystem detected in %s\n", dir)
			return ExitNoChecks
		}
		fmt.Fprintf(stderr, "zeroci: detection failed: %v\n", err)
		return ExitUsage
	}

	yamlBytes, err := detect.FormatYAML(res.Config)
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: failed to format yaml: %v\n", err)
		return ExitInternal
	}

	fmt.Fprintf(stdout, "# Detected ecosystem: %s\n", res.Ecosystem)
	_, _ = stdout.Write(yamlBytes)
	return ExitOK
}
