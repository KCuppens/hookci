// Package services runs the run-scoped service containers jobs depend on.
// In M0 that is PostgreSQL only.
//
// The postgres container never joins the job's network namespace: docker
// cannot join a netns given by path, so it runs with --network none and has
// no network at all. Jobs reach it only through the unix socket that is
// bind-mounted into the run dir at <run>/pg. The docker socket itself is
// never exposed to jobs; only the agent talks to docker.
package services

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/isolation"
)

const (
	// LabelRun is the container label key whose value is the run id.
	LabelRun = "hookci.run"
	// DefaultPGImage is the postgres image used when the config names none.
	DefaultPGImage = "postgres:16-alpine"
	socketDirMode  = 0o777
)

var (
	ErrDockerMissing = errors.New("services: docker not found")
	ErrNotReady      = errors.New("services: postgres not ready before timeout")
)

const (
	defaultReadyTimeout = 30 * time.Second
	defaultPollEvery    = 250 * time.Millisecond
	// execTimeout bounds each docker exec of a readiness poll, so a stuck
	// pg_isready or psql cannot hold a poll open.
	execTimeout = 5 * time.Second
	// stopTimeout bounds the cleanup rm -f after a failed start, which runs
	// even when the caller's context is already cancelled.
	stopTimeout = 30 * time.Second
	// pidsLimit bounds the container's processes: postgres runs one per
	// connection plus a few background workers, well under this.
	pidsLimit = 512

	containerSocketDir = "/var/run/postgresql"
	containerDataDir   = "/var/lib/postgresql/data"
)

// containerCaps are the only capabilities the container keeps. The official
// image's entrypoint starts as root, chowns and chmods the data and socket
// dirs (CHOWN, FOWNER, DAC_OVERRIDE) and then drops to the postgres user
// with gosu or su-exec (SETUID, SETGID).
var containerCaps = []string{"CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"}

// PostgresOptions configures one run's postgres container.
type PostgresOptions struct {
	RunID        string
	RunDir       string        // <state>/runs/<id>; socket dir is RunDir/pg
	Image        string        // "" -> DefaultPGImage
	Tmpfs        bool          // default true from config
	CPUs         float64       // from run limits
	MemoryBytes  int64         // from run limits
	ReadyTimeout time.Duration // default 30s
	PollEvery    time.Duration // default 250ms
	Docker       Docker
	Clock        func() time.Time                           // nil -> time.Now
	Sleep        func(context.Context, time.Duration) error // nil -> ctx-aware sleep; fake in tests
}

// Postgres is a started postgres container.
type Postgres struct {
	Name      string // hookci-svc-<run>-postgres
	SocketDir string // <RunDir>/pg

	docker Docker
}

// ContainerName is the docker container name of runID's postgres. The run
// id is sanitized like a systemd unit name part.
func ContainerName(runID string) string {
	return "hookci-svc-" + isolation.SanitizeUnitPart(runID) + "-postgres"
}

// BuildRunArgv returns the arguments to the docker binary that start the
// postgres container for o.
func BuildRunArgv(o PostgresOptions) []string {
	image := o.Image
	if image == "" {
		image = DefaultPGImage
	}
	argv := []string{
		"run", "-d", "--rm=false",
		"--name", ContainerName(o.RunID),
		"--label", LabelRun + "=" + o.RunID,
		"--cgroup-parent=hookci.slice",
		"--cpus", fmt.Sprintf("%g", o.CPUs),
		"--memory", fmt.Sprintf("%db", o.MemoryBytes),
		"--network", "none",
		"--pids-limit", fmt.Sprintf("%d", pidsLimit),
		"--security-opt", "no-new-privileges",
		"--cap-drop", "ALL",
	}
	for _, c := range containerCaps {
		argv = append(argv, "--cap-add", c)
	}
	if o.Tmpfs {
		argv = append(argv, "--tmpfs", fmt.Sprintf("%s:rw,size=%d", containerDataDir, o.MemoryBytes/2))
	}
	return append(argv,
		"-v", socketDir(o.RunDir)+":"+containerSocketDir,
		"-e", "POSTGRES_HOST_AUTH_METHOD=trust",
		image,
	)
}

// StartPostgres creates the socket dir, starts the container and waits
// until the final postgres server answers queries. A container left over from
// a crashed run with the same name is removed and the start retried once. A
// failed docker run removes whatever container it may have created. If
// postgres is not ready within ReadyTimeout the error wraps ErrNotReady,
// carries the tail of the container log, and the container is removed.
func StartPostgres(ctx context.Context, o PostgresOptions) (*Postgres, error) {
	if o.Image != "" && !config.ValidPostgresImage(o.Image) {
		return nil, fmt.Errorf("services: invalid postgres image %q: only the official postgres image or pgvector/pgvector with a tag or digest", o.Image)
	}
	if o.ReadyTimeout <= 0 {
		o.ReadyTimeout = defaultReadyTimeout
	}
	if o.PollEvery <= 0 {
		o.PollEvery = defaultPollEvery
	}
	if o.Clock == nil {
		o.Clock = time.Now
	}
	if o.Sleep == nil {
		o.Sleep = sleep
	}

	dir := socketDir(o.RunDir)
	if err := os.MkdirAll(dir, socketDirMode); err != nil {
		return nil, fmt.Errorf("services: create postgres socket dir: %w", err)
	}
	// MkdirAll is subject to the umask; both the container's postgres user
	// and the job user must be able to use the socket.
	if err := os.Chmod(dir, socketDirMode); err != nil {
		return nil, fmt.Errorf("services: chmod postgres socket dir: %w", err)
	}

	p := &Postgres{Name: ContainerName(o.RunID), SocketDir: dir, docker: o.Docker}
	argv := BuildRunArgv(o)
	_, stderr, err := o.Docker.run(ctx, argv...)
	if err != nil && strings.Contains(stderr, "is already in use") {
		if _, _, rmErr := o.Docker.run(ctx, "rm", "-f", p.Name); rmErr != nil {
			return nil, fmt.Errorf("services: remove stale container %s: %w", p.Name, rmErr)
		}
		_, _, err = o.Docker.run(ctx, argv...)
	}
	if err != nil {
		err = fmt.Errorf("services: start postgres %s: %w", p.Name, err)
		if errors.Is(err, ErrDockerMissing) {
			return nil, err
		}
		return nil, errors.Join(err, p.stopDetached(ctx))
	}

	if err := p.waitReady(ctx, o); err != nil {
		return nil, errors.Join(err, p.stopDetached(ctx))
	}
	return p, nil
}

// stopDetached removes the container under stopTimeout even when ctx is
// already cancelled.
func (p *Postgres) stopDetached(ctx context.Context) error {
	stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), stopTimeout)
	defer cancel()
	return p.Stop(stopCtx)
}

// waitReady polls until the final server is up or ReadyTimeout passes. Each
// poll runs pg_isready over the container's socket, then a query. pg_isready
// alone also passes while the image entrypoint's temporary init server runs;
// that server is started with listen_addresses=” and restarted afterwards,
// so only a non-empty listen_addresses proves the final server answers.
func (p *Postgres) waitReady(ctx context.Context, o PostgresOptions) error {
	deadline := o.Clock().Add(o.ReadyTimeout)
	readyCtx, cancel := context.WithTimeout(ctx, o.ReadyTimeout)
	defer cancel()
	for {
		if p.ready(readyCtx) {
			return nil
		}
		if !o.Clock().Before(deadline) || (readyCtx.Err() != nil && ctx.Err() == nil) {
			logCtx, cancelLog := context.WithTimeout(ctx, execTimeout)
			logs, logErr, _ := p.docker.run(logCtx, "logs", "--tail", "40", p.Name)
			cancelLog()
			return fmt.Errorf("%w after %s: %s: %s", ErrNotReady, o.ReadyTimeout, p.Name, strings.TrimSpace(logs+logErr))
		}
		if err := o.Sleep(ctx, o.PollEvery); err != nil {
			return fmt.Errorf("services: wait for postgres %s: %w", p.Name, err)
		}
	}
}

// ready runs one poll; every docker exec gets its own execTimeout.
func (p *Postgres) ready(ctx context.Context) bool {
	exec := func(args ...string) (string, error) {
		ctx, cancel := context.WithTimeout(ctx, execTimeout)
		defer cancel()
		out, _, err := p.docker.run(ctx, append([]string{"exec", p.Name}, args...)...)
		return out, err
	}
	if _, err := exec("pg_isready", "-h", containerSocketDir, "-U", "postgres"); err != nil {
		return false
	}
	out, err := exec("psql", "-h", containerSocketDir, "-U", "postgres", "-d", "postgres", "-tAc", "SHOW listen_addresses")
	return err == nil && strings.TrimSpace(out) != ""
}

// Env returns DATABASE_URL plus PGHOST, PGUSER, PGDATABASE.
func (p *Postgres) Env() []string {
	return []string{
		"DATABASE_URL=postgresql://postgres@/postgres?host=" + p.SocketDir,
		"PGHOST=" + p.SocketDir,
		"PGUSER=postgres",
		"PGDATABASE=postgres",
	}
}

// Stop runs docker rm -f; nil-safe, idempotent, ignores "No such container".
func (p *Postgres) Stop(ctx context.Context) error {
	if p == nil {
		return nil
	}
	_, stderr, err := p.docker.run(ctx, "rm", "-f", p.Name)
	if err != nil && !strings.Contains(stderr, "No such container") {
		return fmt.Errorf("services: stop postgres %s: %w", p.Name, err)
	}
	return nil
}

func socketDir(runDir string) string {
	return filepath.Join(runDir, "pg")
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
