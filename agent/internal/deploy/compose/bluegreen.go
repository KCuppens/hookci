package compose

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/pmezard/go-difflib/difflib"
	"gopkg.in/yaml.v3"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/health"
	"github.com/KCuppens/zerocideploy/agent/internal/proxy"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// Step outputs of the compose-bluegreen plan.
const (
	outImage     = "image"
	outPrevColor = "prev_color"
	outColor     = "color"
	outPort      = "port"
	outOverride  = "override"
	outSwapped   = "swapped"
)

const (
	defaultComposeFile    = "docker-compose.yml"
	defaultVerifyWindow   = 60 * time.Second
	defaultVerifyInterval = 5 * time.Second
	defaultExpect         = 200
)

// migrateIndex is the plan index of the migrate step.
const migrateIndex = 2

// BlueGreen is the compose-bluegreen strategy: it starts the idle color in
// its own compose project, gates on health, swaps the proxy route to it,
// watches a verify window, and writes the color marker last.
type BlueGreen struct {
	Store    *store.Store
	Proxy    proxy.ProxyAdapter
	Health   *health.Checker
	StateDir string                           // agent state dir; marker default <StateDir>/deploy/<repo>/<env>/active-color
	WorkDir  func(run store.DeployRun) string // checkout dir of the run's sha
}

// Name returns the strategy name of deployments.<env>.strategy.
func (b *BlueGreen) Name() string { return "compose-bluegreen" }

// Plan returns the eight compose-bluegreen steps.
func (b *BlueGreen) Plan(run store.DeployRun, cfg config.Deployment) ([]deploy.Step, error) {
	if cfg.Compose == nil {
		return nil, fmt.Errorf("deployments.%s.compose: required for compose-bluegreen; add compose.project and compose.service", run.Env)
	}
	if cfg.Route == nil {
		return nil, fmt.Errorf("deployments.%s.route: required for compose-bluegreen; add route.kind and route.file", run.Env)
	}
	if cfg.Health == nil {
		return nil, fmt.Errorf("deployments.%s.health: required for compose-bluegreen; add health.url with {port}", run.Env)
	}
	if _, err := ImageTag(cfg.Compose.Project, run.SHA); err != nil {
		return nil, fmt.Errorf("deployments.%s.%w", run.Env, err)
	}
	if _, _, err := verifyTiming(run.Env, cfg); err != nil {
		return nil, err
	}
	return []deploy.Step{
		{Name: "build", Phase: deploy.PhaseApply, Run: b.build},
		{Name: "prepare", Phase: deploy.PhaseApply, Run: b.prepare},
		{Name: "migrate", Phase: deploy.PhaseApply, Run: b.migrate},
		{Name: "start", Phase: deploy.PhaseApply, Run: b.start},
		{Name: "health", Phase: deploy.PhaseApply, Run: b.health},
		{Name: "swap", Phase: deploy.PhaseApply, Run: b.swap},
		{Name: "verify", Phase: deploy.PhaseVerify, Run: b.verify},
		{Name: "finalize", Phase: deploy.PhaseVerify, Run: b.finalize},
	}, nil
}

// Preview shows the plan of a deploy of pc.SHA: the color it would target,
// that color's port (allocated or next free, reserving none), the override
// and the route diff. It reads the marker and route file through
// pc.ReadFile and runs and writes nothing.
func (b *BlueGreen) Preview(ctx context.Context, pc deploy.PreviewContext) (deploy.PlanPreview, error) {
	run, cfg := store.DeployRun{Repo: pc.Repo, Env: pc.Env, SHA: pc.SHA}, pc.Cfg
	steps, err := b.Plan(run, cfg)
	if err != nil {
		return deploy.PlanPreview{}, err
	}
	active, err := readMarker(pc.ReadFile, b.markerPath(run, cfg))
	if err != nil {
		return deploy.PlanPreview{}, err
	}
	target := OtherColor(active)
	port, err := pc.Store.GetPortAllocation(ctx, run.Repo, run.Env, target)
	if errors.Is(err, store.ErrNotFound) {
		port, err = pc.Store.NextFreePort(ctx)
	}
	if err != nil {
		return deploy.PlanPreview{}, fmt.Errorf("deployments.%s: %w", run.Env, err)
	}
	image, err := ImageTag(cfg.Compose.Project, run.SHA)
	if err != nil {
		return deploy.PlanPreview{}, err
	}
	override, err := renderOverride(run.Env, b.WorkDir(run), cfg, image, target, port)
	if err != nil {
		return deploy.PlanPreview{}, err
	}
	route, err := b.renderRoute(run, cfg, target, port)
	if err != nil {
		return deploy.PlanPreview{}, err
	}
	current, err := pc.ReadFile(cfg.Route.File)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return deploy.PlanPreview{}, fmt.Errorf("compose: reading route %s: %w", cfg.Route.File, err)
	}
	diff, err := difflib.GetUnifiedDiffString(difflib.UnifiedDiff{
		A: diffLines(current), B: diffLines(route),
		FromFile: cfg.Route.File, ToFile: cfg.Route.File, Context: 3,
	})
	if err != nil {
		return deploy.PlanPreview{}, fmt.Errorf("compose: diffing route %s: %w", cfg.Route.File, err)
	}
	return deploy.PlanPreview{
		Steps:       deploy.StepNames(steps),
		ActiveColor: active,
		TargetColor: target,
		TargetPort:  port,
		Image:       image,
		Override:    string(override),
		RouteDiff:   diff,
	}, nil
}

// build builds <project>:<sha7> with BuildKit unless the image exists.
func (b *BlueGreen) build(ctx context.Context, sc *deploy.StepContext) error {
	return buildImage(ctx, sc, b.WorkDir(sc.Run))
}

// buildImage builds <project>:<sha7> of the checkout in workdir with
// BuildKit unless the image exists, and sets the image output.
func buildImage(ctx context.Context, sc *deploy.StepContext, workdir string) error {
	image, err := ImageTag(sc.Cfg.Compose.Project, sc.Run.SHA)
	if err != nil {
		return err
	}
	if err := sc.Exec.Run(ctx, "build", []string{"docker", "image", "inspect", image},
		deploy.ExecOpts{Dir: workdir, Stdout: io.Discard, Stderr: io.Discard}); err == nil {
		fmt.Fprintf(sc.Log, "image %s exists, skipping build\n", image)
		sc.Outputs[outImage] = image
		return nil
	} else if ctx.Err() != nil {
		return err
	}
	buildCtx, dockerfile, err := buildSource(composeFile(workdir, sc.Cfg), sc.Cfg.Compose.Service)
	if err != nil {
		return fmt.Errorf("deployments.%s.compose: %w", sc.Run.Env, err)
	}
	if err := sc.Exec.Run(ctx, "build", []string{"docker", "build", "-t", image, "-f", dockerfile, "."}, deploy.ExecOpts{
		Dir: buildCtx, Env: map[string]string{"DOCKER_BUILDKIT": "1"}, Stdout: sc.Log, Stderr: sc.Log,
	}); err != nil {
		return err
	}
	sc.Outputs[outImage] = image
	return nil
}

// prepare picks the target color from the marker, allocates its port and
// writes its compose override. A resumed run keeps its stored color.
func (b *BlueGreen) prepare(ctx context.Context, sc *deploy.StepContext) error {
	run, cfg := sc.Run, sc.Cfg
	color, prev := sc.Outputs[outColor], sc.Outputs[outPrevColor]
	if color == "" {
		var err error
		if prev, err = ReadMarker(b.markerPath(run, cfg)); err != nil {
			return err
		}
		color = OtherColor(prev)
	}
	port, err := b.Store.AllocatePort(ctx, run.Repo, run.Env, color, store.DefaultPortLo, store.DefaultPortHi)
	if err != nil {
		return fmt.Errorf("deployments.%s: %w", run.Env, err)
	}
	image, err := ImageTag(cfg.Compose.Project, run.SHA)
	if err != nil {
		return err
	}
	override, err := renderOverride(run.Env, b.WorkDir(run), cfg, image, color, port)
	if err != nil {
		return err
	}
	path := filepath.Join(b.envDir(run), color+".override.yml")
	if err := writeFileAtomic(path, override); err != nil {
		return fmt.Errorf("compose: writing override: %w", err)
	}
	sc.Outputs[outPrevColor] = prev
	sc.Outputs[outColor] = color
	sc.Outputs[outPort] = strconv.Itoa(port)
	sc.Outputs[outOverride] = path
	return nil
}

// migrate runs migrate.run in the new image, when set.
func (b *BlueGreen) migrate(ctx context.Context, sc *deploy.StepContext) error {
	if sc.Cfg.Migrate == nil || sc.Cfg.Migrate.Run == "" {
		return nil
	}
	argv, err := b.composeArgv(sc)
	if err != nil {
		return err
	}
	argv = append(argv, "run", "--rm", sc.Cfg.Compose.Service, "sh", "-c", sc.Cfg.Migrate.Run)
	return sc.Exec.Run(ctx, "migrate", argv, b.execOpts(sc))
}

// start brings the target color up.
func (b *BlueGreen) start(ctx context.Context, sc *deploy.StepContext) error {
	argv, err := b.composeArgv(sc)
	if err != nil {
		return err
	}
	return sc.Exec.Run(ctx, "start", append(argv, "up", "-d", "--remove-orphans"), b.execOpts(sc))
}

// health waits until the target color answers its health URL.
func (b *BlueGreen) health(ctx context.Context, sc *deploy.StepContext) error {
	spec, err := healthSpec(sc)
	if err != nil {
		return err
	}
	return b.Health.Wait(ctx, spec)
}

// swap points the route at the target color and reloads the proxy, unless
// the route file already holds that route.
func (b *BlueGreen) swap(ctx context.Context, sc *deploy.StepContext) error {
	port, err := outputPort(sc)
	if err != nil {
		return err
	}
	sc.Outputs[outSwapped] = "true"
	return b.applyRoute(ctx, sc, sc.Outputs[outColor], port)
}

// verify probes the target color every verify.interval for verify.window;
// any probe without the expected status fails the step.
func (b *BlueGreen) verify(ctx context.Context, sc *deploy.StepContext) error {
	window, interval, err := verifyTiming(sc.Run.Env, sc.Cfg)
	if err != nil {
		return err
	}
	spec, err := healthSpec(sc)
	if err != nil {
		return err
	}
	spec.Interval = interval
	start := sc.Clock.Now()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-sc.Clock.After(interval):
		}
		status, _, err := b.Health.Probe(ctx, spec)
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		elapsed := sc.Clock.Now().Sub(start)
		if err != nil || status != spec.Expect {
			outcome := strconv.Itoa(status)
			if err != nil {
				outcome = err.Error()
			}
			return fmt.Errorf("deployments.%s.verify: %s at %s of %s; previous color restored",
				sc.Run.Env, outcome, elapsed, window)
		}
		if elapsed >= window {
			return nil
		}
	}
}

// finalize writes the marker, then stops the previous color.
func (b *BlueGreen) finalize(ctx context.Context, sc *deploy.StepContext) error {
	color := sc.Outputs[outColor]
	if err := WriteMarker(b.markerPath(sc.Run, sc.Cfg), color); err != nil {
		return err
	}
	if prev := sc.Outputs[outPrevColor]; prev != "" {
		if err := b.down(ctx, sc, "finalize", prev); err != nil {
			return err
		}
	}
	return nil
}

// Rollback restores the previous color. Before the swap it only stops the
// target color; after it, it routes back to the previous color (or removes
// the route on a first deploy), reloads, and stops the target color. It
// never touches the marker.
func (b *BlueGreen) Rollback(ctx context.Context, sc *deploy.StepContext, failedIndex int) error {
	if failedIndex >= migrateIndex && sc.Cfg.Migrate != nil && sc.Cfg.Migrate.Run != "" {
		fmt.Fprintln(sc.Log, "migrations are forward-only and were not reverted")
	}
	target := sc.Outputs[outColor]
	if target == "" {
		return nil
	}
	if sc.Outputs[outSwapped] == "true" {
		if err := b.restoreRoute(ctx, sc); err != nil {
			return err
		}
	}
	return b.down(ctx, sc, "rollback", target)
}

// restoreRoute routes back to the previous color, or removes the route when
// there was none.
func (b *BlueGreen) restoreRoute(ctx context.Context, sc *deploy.StepContext) error {
	run := sc.Run
	prev := sc.Outputs[outPrevColor]
	if prev == "" {
		file := sc.Cfg.Route.File
		if err := os.Remove(file); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("compose: removing route %s: %w", file, err)
		}
		if err := b.Proxy.Reload(ctx); err != nil {
			return fmt.Errorf("compose: reload after removing route %s: %w", file, err)
		}
		return nil
	}
	port, err := b.Store.AllocatePort(ctx, run.Repo, run.Env, prev, store.DefaultPortLo, store.DefaultPortHi)
	if err != nil {
		return fmt.Errorf("deployments.%s: port of %s: %w", run.Env, prev, err)
	}
	return b.applyRoute(ctx, sc, prev, port)
}

// applyRoute renders the route to color on port and applies it, skipping
// the write and reload when the route file already holds it.
func (b *BlueGreen) applyRoute(ctx context.Context, sc *deploy.StepContext, color string, port int) error {
	r := sc.Cfg.Route
	content, err := b.renderRoute(sc.Run, sc.Cfg, color, port)
	if err != nil {
		return err
	}
	current, err := os.ReadFile(r.File)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("compose: reading route %s: %w", r.File, err)
	}
	if err == nil && bytes.Equal(current, content) {
		fmt.Fprintf(sc.Log, "route %s already points at %s, skipping reload\n", r.File, color)
		return nil
	}
	return proxy.ApplyAndReload(ctx, b.Proxy, r.File, content)
}

// down stops the compose project of color, keeping its images.
func (b *BlueGreen) down(ctx context.Context, sc *deploy.StepContext, step, color string) error {
	project, err := ProjectName(sc.Cfg.Compose.Project, color)
	if err != nil {
		return err
	}
	return sc.Exec.Run(ctx, step, []string{"docker", "compose", "-p", project, "down"},
		deploy.ExecOpts{Dir: b.WorkDir(sc.Run), Stdout: sc.Log, Stderr: sc.Log})
}

// composeArgv is "docker compose -p <project>-<color> -f <file> -f <override>".
func (b *BlueGreen) composeArgv(sc *deploy.StepContext) ([]string, error) {
	project, err := ProjectName(sc.Cfg.Compose.Project, sc.Outputs[outColor])
	if err != nil {
		return nil, err
	}
	return []string{"docker", "compose", "-p", project,
		"-f", composeFile(b.WorkDir(sc.Run), sc.Cfg), "-f", sc.Outputs[outOverride]}, nil
}

func (b *BlueGreen) execOpts(sc *deploy.StepContext) deploy.ExecOpts {
	return deploy.ExecOpts{Dir: b.WorkDir(sc.Run), Stdout: sc.Log, Stderr: sc.Log}
}

// envDir is <StateDir>/deploy/<repo>/<env>.
func (b *BlueGreen) envDir(run store.DeployRun) string {
	return filepath.Join(b.StateDir, "deploy", run.Repo, run.Env)
}

// renderRoute renders the route of run to color on port.
func (b *BlueGreen) renderRoute(run store.DeployRun, cfg config.Deployment, color string, port int) ([]byte, error) {
	content, err := b.Proxy.Render(proxy.RouteSpec{
		Repo: run.Repo, Env: run.Env, Color: color, UpstreamHost: cfg.Route.UpstreamHost, Port: port,
	})
	if err != nil {
		return nil, fmt.Errorf("deployments.%s.route: %w", run.Env, err)
	}
	return content, nil
}

// markerPath is compose.marker, or <StateDir>/deploy/<repo>/<env>/active-color.
func (b *BlueGreen) markerPath(run store.DeployRun, cfg config.Deployment) string {
	if cfg.Compose.Marker != nil && *cfg.Compose.Marker != "" {
		return *cfg.Compose.Marker
	}
	return filepath.Join(b.envDir(run), "active-color")
}

func composeFile(workdir string, cfg config.Deployment) string {
	file := cfg.Compose.File
	if file == "" {
		file = defaultComposeFile
	}
	return filepath.Join(workdir, file)
}

// diffLines splits b into newline-terminated lines for difflib, so an empty
// file has no lines and a missing final newline adds none.
func diffLines(b []byte) []string {
	lines := strings.SplitAfter(string(b), "\n")
	if last := len(lines) - 1; lines[last] == "" {
		lines = lines[:last]
	} else {
		lines[last] += "\n"
	}
	return lines
}

// renderOverride renders the compose override of cfg's service in workdir:
// image, the shared network, and color on host port when port is not 0.
func renderOverride(env, workdir string, cfg config.Deployment, image, color string, port int) ([]byte, error) {
	in := OverrideInput{
		Env:         env,
		ComposeFile: composeFile(workdir, cfg),
		Service:     cfg.Compose.Service,
		Image:       image,
		HostPort:    port,
		Color:       color,
	}
	if cfg.Compose.SharedNetwork != nil {
		in.SharedNetwork = *cfg.Compose.SharedNetwork
	}
	return RenderOverride(in)
}

// buildSource returns the build context directory and the Dockerfile
// (relative to it) of service in composePath: build.context and
// build.dockerfile when set, otherwise the compose file directory and
// Dockerfile.
func buildSource(composePath, service string) (dir, dockerfile string, err error) {
	raw, err := os.ReadFile(composePath)
	if err != nil {
		return "", "", fmt.Errorf("reading %s: %w", composePath, err)
	}
	var doc struct {
		Services map[string]struct {
			Build yaml.Node `yaml:"build"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return "", "", fmt.Errorf("parsing %s: %w", composePath, err)
	}
	svc, ok := doc.Services[service]
	if !ok {
		return "", "", fmt.Errorf("service: service %s not found in %s; set compose.service to a service in that file", service, composePath)
	}
	base := filepath.Dir(composePath)
	dir, dockerfile = ".", "Dockerfile"
	switch svc.Build.Kind {
	case yaml.ScalarNode:
		dir = svc.Build.Value
	case yaml.MappingNode:
		var b struct {
			Context    string `yaml:"context"`
			Dockerfile string `yaml:"dockerfile"`
		}
		if err := svc.Build.Decode(&b); err != nil {
			return "", "", fmt.Errorf("parsing build of service %s in %s: %w", service, composePath, err)
		}
		if b.Context != "" {
			dir = b.Context
		}
		if b.Dockerfile != "" {
			dockerfile = b.Dockerfile
		}
	}
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(base, dir)
	}
	return dir, dockerfile, nil
}

// healthSpec is the health check of the target color.
func healthSpec(sc *deploy.StepContext) (health.Spec, error) {
	port, err := outputPort(sc)
	if err != nil {
		return health.Spec{}, err
	}
	return healthSpecFor(sc, port)
}

// healthSpecFor is deployments.<env>.health with {port} resolved to port.
func healthSpecFor(sc *deploy.StepContext, port int) (health.Spec, error) {
	h := sc.Cfg.Health
	spec := health.Spec{Env: sc.Run.Env, URL: h.Url, Port: port, Expect: h.Expect, Retries: h.Retries}
	if spec.Expect == 0 {
		spec.Expect = defaultExpect
	}
	if h.Interval != "" {
		var err error
		if spec.Interval, err = time.ParseDuration(h.Interval); err != nil {
			return health.Spec{}, fmt.Errorf("deployments.%s.health.interval: %w", sc.Run.Env, err)
		}
	}
	return spec, nil
}

// verifyTiming returns verify.window and verify.interval with their defaults.
func verifyTiming(env string, cfg config.Deployment) (window, interval time.Duration, err error) {
	window, interval = defaultVerifyWindow, defaultVerifyInterval
	if cfg.Verify == nil {
		return window, interval, nil
	}
	if cfg.Verify.Window != "" {
		if window, err = time.ParseDuration(cfg.Verify.Window); err != nil {
			return 0, 0, fmt.Errorf("deployments.%s.verify.window: %w", env, err)
		}
	}
	if cfg.Verify.Interval != "" {
		if interval, err = time.ParseDuration(cfg.Verify.Interval); err != nil {
			return 0, 0, fmt.Errorf("deployments.%s.verify.interval: %w", env, err)
		}
	}
	if interval <= 0 {
		return 0, 0, fmt.Errorf("deployments.%s.verify.interval: must be positive", env)
	}
	return window, interval, nil
}

func outputPort(sc *deploy.StepContext) (int, error) {
	port, err := strconv.Atoi(sc.Outputs[outPort])
	if err != nil {
		return 0, fmt.Errorf("compose: step output port %q: %w", sc.Outputs[outPort], err)
	}
	return port, nil
}
