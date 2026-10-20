package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/detect"
	"github.com/KCuppens/hookci/agent/internal/initdeploy"
)

// initSkeleton is what init writes when detection finds nothing. It is a
// valid config whose only job fails until the user replaces its command.
const initSkeleton = `# hookci found no checks to detect in this project.
# Replace the example job below with your own; each job runs one shell
# command and passes when it exits 0. See hookci validate to check the file.
version: 1
checks:
  # setup steps run once before the jobs, for example to install dependencies:
  # setup:
  #   - run: make deps
  jobs:
    test:
      run: echo "edit .hookci.yml and set the test command" && exit 1
`

func runInit(_ context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	fs.SetOutput(stderr)
	force := fs.Bool("force", false, "overwrite an existing .hookci.yml")
	deploy := fs.Bool("deploy", false, "append a deployments.production block drafted from the compose file")
	yes := fs.Bool("yes", false, "with --deploy, accept the defaults without prompting")
	fs.Usage = func() {
		fmt.Fprintln(stdout, "Usage: hookci init [dir] [flags]")
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Write <dir>/.hookci.yml (default dir .) from the checks hookci detect infers.")
		fmt.Fprintln(stdout, "With --deploy, append deployments.production for the compose service")
		fmt.Fprintln(stdout, "that has both build and ports, keeping the rest of the file as it is.")
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Flags:")
		fs.SetOutput(stdout)
		fs.PrintDefaults()
	}
	dir, code, ok := parseDirArgs(fs, args, stderr)
	if !ok {
		return code
	}
	switch {
	case *yes && !*deploy:
		fmt.Fprintln(stderr, "hookci: --yes only applies to --deploy")
		return ExitUsage
	case *force && *deploy:
		fmt.Fprintln(stderr, "hookci: --force does not apply to --deploy, which never overwrites existing content")
		return ExitUsage
	case *deploy:
		return runInitDeploy(dir, *yes, stdout, stderr)
	}

	path := filepath.Join(dir, ".hookci.yml")
	if _, err := os.Stat(path); err == nil && !*force {
		fmt.Fprintf(stderr, "hookci: %s already exists (use --force to overwrite)\n", path)
		return ExitUsage
	}

	var content []byte
	res, err := detect.DetectDir(dir)
	switch {
	case errors.Is(err, detect.ErrNothingDetected):
		content = []byte(initSkeleton)
		fmt.Fprintf(stderr, "hookci: no checks detected, wrote a skeleton; edit the jobs in %s\n", path)
	case err != nil:
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitUsage
	default:
		if content, err = detect.Render(res); err != nil {
			fmt.Fprintf(stderr, "hookci: render detected config: %v\n", err)
			return ExitInternal
		}
	}

	if err := os.WriteFile(path, content, 0o644); err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitInternal
	}
	// WriteFile keeps the mode of a file it overwrites and is subject to the
	// umask on create; the spec fixes the mode at 0644 either way.
	if err := os.Chmod(path, 0o644); err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitInternal
	}

	_, diags, err := config.Load(path, config.ParseOptions{})
	if err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitInternal
	}
	if diags.HasErrors() {
		fmt.Fprintf(stderr, "hookci: internal error: the written file does not validate\n%s", diags.Format(path))
		return ExitInternal
	}
	fmt.Fprintf(stdout, "wrote %s\n", path)
	return ExitOK
}

// runInitDeploy runs hookci init --deploy on dir, prompting on stdin unless
// yes is set.
func runInitDeploy(dir string, yes bool, stdout, stderr io.Writer) int {
	abs, err := filepath.Abs(dir)
	if err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitUsage
	}
	err = initdeploy.Run(initdeploy.Options{Dir: dir, Repo: filepath.Base(abs), Yes: yes, In: os.Stdin, Out: stdout})
	if err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitUsage
	}
	return ExitOK
}
