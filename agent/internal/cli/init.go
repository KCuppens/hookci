package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/detect"
)

// initSkeleton is what init writes when detection finds nothing. It is a
// valid config whose only job fails until the user replaces its command.
const initSkeleton = `# zeroci found no checks to detect in this project.
# Replace the example job below with your own; each job runs one shell
# command and passes when it exits 0. See zeroci validate to check the file.
version: 1
checks:
  # setup steps run once before the jobs, for example to install dependencies:
  # setup:
  #   - run: make deps
  jobs:
    test:
      run: echo "edit .zeroci.yml and set the test command" && exit 1
`

func runInit(_ context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	fs.SetOutput(stderr)
	force := fs.Bool("force", false, "overwrite an existing .zeroci.yml")
	fs.Usage = func() {
		fmt.Fprintln(stdout, "Usage: zeroci init [dir] [flags]")
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Write <dir>/.zeroci.yml (default dir .) from the checks zeroci detect infers.")
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Flags:")
		fs.SetOutput(stdout)
		fs.PrintDefaults()
	}
	dir, code, ok := parseDirArgs(fs, args, stderr)
	if !ok {
		return code
	}

	path := filepath.Join(dir, ".zeroci.yml")
	if _, err := os.Stat(path); err == nil && !*force {
		fmt.Fprintf(stderr, "zeroci: %s already exists (use --force to overwrite)\n", path)
		return ExitUsage
	}

	var content []byte
	res, err := detect.DetectDir(dir)
	switch {
	case errors.Is(err, detect.ErrNothingDetected):
		content = []byte(initSkeleton)
		fmt.Fprintf(stderr, "zeroci: no checks detected, wrote a skeleton; edit the jobs in %s\n", path)
	case err != nil:
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitUsage
	default:
		if content, err = detect.Render(res); err != nil {
			fmt.Fprintf(stderr, "zeroci: render detected config: %v\n", err)
			return ExitInternal
		}
	}

	if err := os.WriteFile(path, content, 0o644); err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitInternal
	}
	// WriteFile keeps the mode of a file it overwrites and is subject to the
	// umask on create; the spec fixes the mode at 0644 either way.
	if err := os.Chmod(path, 0o644); err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitInternal
	}

	_, diags, err := config.Load(path, config.ParseOptions{})
	if err != nil {
		fmt.Fprintf(stderr, "zeroci: %v\n", err)
		return ExitInternal
	}
	if diags.HasErrors() {
		fmt.Fprintf(stderr, "zeroci: internal error: the written file does not validate\n%s", diags.Format(path))
		return ExitInternal
	}
	fmt.Fprintf(stdout, "wrote %s\n", path)
	return ExitOK
}
