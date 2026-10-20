// Package script is the script deploy strategy: deployments.<env>.run is
// the whole deploy, reporting sub-steps through `::zeroci step <name>` lines.
package script

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

const (
	markerPrefix = "::zeroci step "
	// maxMarkerLine bounds the bytes kept of one output line; longer lines
	// are never markers.
	maxMarkerLine = 256
	// outSubStep is the output holding the last sub-step the script reported.
	outSubStep = "sub_step"
	// failedStepEnv names the last reported sub-step for the rollback command.
	failedStepEnv = "ZEROCI_FAILED_STEP"
)

var stepNameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,39}$`)

// Script runs `sh -c <run>` as the single engine step "run". Every
// `::zeroci step <name>` line on its stdout emits a progress event, and the
// last one names the failed sub-step for `sh -c <rollback>`. The engine
// resumes per step, so a resumed script deploy re-runs run from the start.
type Script struct {
	WorkDir func(run store.DeployRun) string // checkout dir of the run's sha
	Clock   clock.Clock                      // times the reported sub-steps
}

// Name returns the strategy name of deployments.<env>.strategy.
func (s *Script) Name() string { return "script" }

// Plan returns the single step "run".
func (s *Script) Plan(run store.DeployRun, cfg config.Deployment) ([]deploy.Step, error) {
	if cfg.Run == nil || *cfg.Run == "" {
		return nil, fmt.Errorf("deployments.%s.run: required for script; add run with the deploy command", run.Env)
	}
	return []deploy.Step{{Name: "run", Phase: deploy.PhaseApply, Run: s.run}}, nil
}

// Preview shows the single step of a deploy; a script builds no image and
// touches no route the agent knows of.
func (s *Script) Preview(_ context.Context, pc deploy.PreviewContext) (deploy.PlanPreview, error) {
	steps, err := s.Plan(store.DeployRun{Repo: pc.Repo, Env: pc.Env, SHA: pc.SHA}, pc.Cfg)
	if err != nil {
		return deploy.PlanPreview{}, err
	}
	return deploy.PlanPreview{Steps: deploy.StepNames(steps)}, nil
}

// run executes deployments.<env>.run, reporting each marker line as a
// sub-step and logging how long each sub-step took.
func (s *Script) run(ctx context.Context, sc *deploy.StepContext) error {
	delete(sc.Outputs, outSubStep)
	var last string
	var since time.Time
	finish := func(now time.Time) {
		if last != "" {
			fmt.Fprintf(sc.Log, "script step %s took %s\n", last, now.Sub(since).Round(time.Millisecond))
		}
	}
	stdout := &markerWriter{out: sc.Log, onMarker: func(name string) {
		now := s.Clock.Now()
		finish(now)
		last, since = name, now
		if sc.Progress != nil {
			sc.Progress(name)
		}
	}}
	err := sc.Exec.Run(ctx, "run", []string{"sh", "-c", *sc.Cfg.Run}, deploy.ExecOpts{
		Dir: s.WorkDir(sc.Run), Stdout: stdout, Stderr: sc.Log,
	})
	stdout.flush()
	if last != "" {
		finish(s.Clock.Now())
		sc.Outputs[outSubStep] = last
	}
	return err
}

// Rollback runs deployments.<env>.rollback, when set, with
// ZEROCI_FAILED_STEP naming the last sub-step the script reported (empty
// when it reported none). Without rollback it does nothing.
func (s *Script) Rollback(ctx context.Context, sc *deploy.StepContext, _ int) error {
	if sc.Cfg.Rollback == nil || *sc.Cfg.Rollback == "" {
		return nil
	}
	if err := sc.Exec.Run(ctx, "rollback", []string{"sh", "-c", *sc.Cfg.Rollback}, deploy.ExecOpts{
		Dir:    s.WorkDir(sc.Run),
		Env:    map[string]string{failedStepEnv: sc.Outputs[outSubStep]},
		Stdout: sc.Log, Stderr: sc.Log,
	}); err != nil {
		return fmt.Errorf("deployments.%s.rollback: %w", sc.Run.Env, err)
	}
	return nil
}

// ParseStepMarker returns the sub-step name of a `::zeroci step <name>`
// line. The prefix must start the line; the trimmed name must match
// ^[a-z0-9][a-z0-9_.-]{0,39}$. Any other line is plain output.
func ParseStepMarker(line string) (name string, ok bool) {
	rest, ok := strings.CutPrefix(line, markerPrefix)
	if !ok {
		return "", false
	}
	name = strings.TrimSpace(rest)
	if !stepNameRE.MatchString(name) {
		return "", false
	}
	return name, true
}

// markerWriter passes command output to out and calls onMarker for every
// marker line. Writes must not be concurrent.
type markerWriter struct {
	out      io.Writer
	onMarker func(name string)
	line     []byte // start of the current line, up to maxMarkerLine bytes
	long     bool   // the current line outgrew maxMarkerLine
}

func (w *markerWriter) Write(p []byte) (int, error) {
	n, err := w.out.Write(p)
	for rest := p; len(rest) > 0; {
		i := bytes.IndexByte(rest, '\n')
		if i < 0 {
			w.keep(rest)
			break
		}
		w.keep(rest[:i])
		w.endLine()
		rest = rest[i+1:]
	}
	return n, err
}

// flush ends an unterminated last line.
func (w *markerWriter) flush() {
	if len(w.line) > 0 || w.long {
		w.endLine()
	}
}

func (w *markerWriter) keep(b []byte) {
	if w.long {
		return
	}
	if len(w.line)+len(b) > maxMarkerLine {
		w.line, w.long = w.line[:0], true
		return
	}
	w.line = append(w.line, b...)
}

func (w *markerWriter) endLine() {
	if !w.long {
		if name, ok := ParseStepMarker(string(w.line)); ok {
			w.onMarker(name)
		}
	}
	w.line, w.long = w.line[:0], false
}
