package services

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/testutil"
)

// fakeClock is a clock that only moves when Sleep is called.
type fakeClock struct{ now time.Time }

func (c *fakeClock) Now() time.Time { return c.now }

func (c *fakeClock) Sleep(_ context.Context, d time.Duration) error {
	c.now = c.now.Add(d)
	return nil
}

func testOptions(t *testing.T, fake *execx.Fake) PostgresOptions {
	t.Helper()
	clock := &fakeClock{now: time.Unix(1_700_000_000, 0)}
	return PostgresOptions{
		RunID:       "01HX",
		RunDir:      t.TempDir(),
		Tmpfs:       true,
		CPUs:        2,
		MemoryBytes: 4 << 30,
		Docker:      Docker{Runner: fake},
		Clock:       clock.Now,
		Sleep:       clock.Sleep,
	}
}

// countCalls counts recorded docker calls whose args start with prefix.
func countCalls(fake *execx.Fake, prefix ...string) int {
	n := 0
	for _, c := range fake.Calls {
		if c.Name == "docker" && len(c.Args) >= len(prefix) && slices.Equal(c.Args[:len(prefix)], prefix) {
			n++
		}
	}
	return n
}

// isPGReady reports whether c is the readiness probe.
func isPGReady(c execx.Cmd) bool {
	return len(c.Args) > 2 && c.Args[0] == "exec" && c.Args[2] == "pg_isready"
}

// onFinalServer answers the readiness query the way the final server does.
func onFinalServer(fake *execx.Fake) {
	fake.On("docker", []string{"exec", "hookci-svc-01HX-postgres", "psql"}, execx.FakeResponse{Stdout: "*\n"})
}

func TestContainerName(t *testing.T) {
	if got := ContainerName("01HX"); got != "hookci-svc-01HX-postgres" {
		t.Errorf("ContainerName(01HX) = %q", got)
	}
	if got := ContainerName("a/b c;d"); got != "hookci-svc-a_b_c_d-postgres" {
		t.Errorf("ContainerName(unsafe) = %q, want unsafe characters replaced by _", got)
	}
}

func TestBuildRunArgvGolden(t *testing.T) {
	argv := BuildRunArgv(PostgresOptions{
		RunID:       "01HX",
		RunDir:      "/var/lib/hookci/local/runs/01HX",
		Tmpfs:       true,
		CPUs:        1.5,
		MemoryBytes: 2 << 30,
	})
	testutil.Golden(t, "postgres_run_argv", []byte(strings.Join(argv, "\n")+"\n"))
}

func TestBuildRunArgvNoTmpfs(t *testing.T) {
	argv := BuildRunArgv(PostgresOptions{RunID: "r1", RunDir: "/s/runs/r1", CPUs: 2, MemoryBytes: 4 << 30})
	for _, a := range argv {
		if a == "--tmpfs" || strings.HasPrefix(a, "/var/lib/postgresql/data") {
			t.Fatalf("argv with Tmpfs=false contains %q: %v", a, argv)
		}
	}
}

func TestBuildRunArgvNetworkNone(t *testing.T) {
	argv := BuildRunArgv(PostgresOptions{RunID: "r1", RunDir: "/s/runs/r1", Tmpfs: true, CPUs: 2, MemoryBytes: 4 << 30})
	i := slices.Index(argv, "--network")
	if i < 0 || i+1 >= len(argv) || argv[i+1] != "none" {
		t.Errorf("argv lacks --network none: %v", argv)
	}
	for _, a := range argv {
		if a == "-p" || a == "--publish" || strings.HasPrefix(a, "--publish=") || strings.HasPrefix(a, "-P") {
			t.Errorf("argv publishes a port with %q: %v", a, argv)
		}
	}
}

func TestStartPostgresReady(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", []string{"run"}, execx.FakeResponse{Stdout: "c0ffee\n"})
	onFinalServer(fake)
	probes := 0
	fake.On("docker", []string{"exec"}, execx.FakeResponse{Fn: func(execx.Cmd) error {
		probes++
		if probes == 1 {
			return &execx.ExitError{Code: 2}
		}
		return nil
	}})
	o := testOptions(t, fake)

	p, err := StartPostgres(context.Background(), o)
	if err != nil {
		t.Fatalf("StartPostgres: %v", err)
	}
	if p.Name != "hookci-svc-01HX-postgres" || p.SocketDir != filepath.Join(o.RunDir, "pg") {
		t.Errorf("Postgres = %+v", p)
	}
	n := 0
	for _, c := range fake.Calls {
		if isPGReady(c) {
			n++
			if want := []string{"exec", p.Name, "pg_isready", "-h", "/var/run/postgresql", "-U", "postgres"}; !slices.Equal(c.Args, want) {
				t.Errorf("probe args = %v, want %v", c.Args, want)
			}
		}
	}
	if n != 2 {
		t.Errorf("pg_isready calls = %d, want 2", n)
	}
	want := []string{"exec", p.Name, "psql", "-h", "/var/run/postgresql", "-U", "postgres", "-d", "postgres", "-tAc", "SHOW listen_addresses"}
	if n := countCalls(fake, want...); n != 1 {
		t.Errorf("readiness queries = %d, want 1 with args %v", n, want)
	}
	if !slices.Equal(fake.Calls[0].Args, BuildRunArgv(o)) {
		t.Errorf("first call = %v, want the run argv", fake.Calls[0].Args)
	}
	if fake.Called("docker", "rm") {
		t.Error("a ready postgres was removed")
	}
}

// The image entrypoint's temporary init server passes pg_isready on the
// socket but listens nowhere else; StartPostgres must wait for the restart.
func TestStartPostgresWaitsForFinalServer(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", []string{"run"}, execx.FakeResponse{})
	queries := 0
	fake.On("docker", []string{"exec", "hookci-svc-01HX-postgres", "psql"}, execx.FakeResponse{Fn: func(c execx.Cmd) error {
		queries++
		if queries > 1 {
			_, _ = c.Stdout.Write([]byte("*\n"))
		}
		return nil
	}})
	fake.On("docker", []string{"exec"}, execx.FakeResponse{})

	if _, err := StartPostgres(context.Background(), testOptions(t, fake)); err != nil {
		t.Fatalf("StartPostgres: %v", err)
	}
	if queries != 2 {
		t.Errorf("readiness queries = %d, want 2 (init server, then final server)", queries)
	}
	if n := countCalls(fake, "exec", "hookci-svc-01HX-postgres", "pg_isready"); n != 2 {
		t.Errorf("pg_isready calls = %d, want 2", n)
	}
}

// A docker run that fails after creating the container must not leave it.
func TestStartPostgresRunFailureRemovesContainer(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", []string{"run"}, execx.FakeResponse{Code: 125, Stderr: "docker: Error response from daemon: failed to set up container networking"})
	fake.On("docker", []string{"rm", "-f", "hookci-svc-01HX-postgres"}, execx.FakeResponse{})

	p, err := StartPostgres(context.Background(), testOptions(t, fake))
	if err == nil || p != nil {
		t.Fatalf("StartPostgres = %+v, %v; want an error", p, err)
	}
	var got []string
	for _, c := range fake.Calls {
		got = append(got, c.Args[0])
	}
	if want := []string{"run", "rm"}; !slices.Equal(got, want) {
		t.Errorf("docker subcommands = %v, want %v", got, want)
	}
}

func TestStartPostgresTimeout(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", []string{"run"}, execx.FakeResponse{})
	fake.On("docker", []string{"exec"}, execx.FakeResponse{Code: 2})
	fake.On("docker", []string{"logs", "--tail", "40"}, execx.FakeResponse{Stdout: "FATAL:  data directory has wrong ownership\n"})
	fake.On("docker", []string{"rm", "-f", "hookci-svc-01HX-postgres"}, execx.FakeResponse{})
	o := testOptions(t, fake)
	o.ReadyTimeout = 2 * time.Second
	o.PollEvery = 500 * time.Millisecond

	p, err := StartPostgres(context.Background(), o)
	if !errors.Is(err, ErrNotReady) {
		t.Fatalf("err = %v, want ErrNotReady", err)
	}
	if p != nil {
		t.Errorf("Postgres = %+v, want nil", p)
	}
	if !strings.Contains(err.Error(), "data directory has wrong ownership") {
		t.Errorf("error %q lacks the docker logs output", err)
	}
	if !fake.Called("docker", "rm", "-f", "hookci-svc-01HX-postgres") {
		t.Error("docker rm -f was not called after the timeout")
	}
	// Probes at t=0, 0.5, 1, 1.5 and 2s, then the deadline is reached.
	if n := countCalls(fake, "exec"); n != 5 {
		t.Errorf("pg_isready calls = %d, want 5", n)
	}
}

func TestStartPostgresStaleNameRetry(t *testing.T) {
	fake := &execx.Fake{}
	runs := 0
	fake.On("docker", []string{"run"}, execx.FakeResponse{Fn: func(c execx.Cmd) error {
		runs++
		if runs == 1 {
			msg := `docker: Error response from daemon: Conflict. The container name "/hookci-svc-01HX-postgres" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.`
			_, _ = c.Stderr.Write([]byte(msg))
			return &execx.ExitError{Code: 125, Stderr: msg}
		}
		return nil
	}})
	fake.On("docker", []string{"rm", "-f", "hookci-svc-01HX-postgres"}, execx.FakeResponse{})
	onFinalServer(fake)
	fake.On("docker", []string{"exec"}, execx.FakeResponse{})

	if _, err := StartPostgres(context.Background(), testOptions(t, fake)); err != nil {
		t.Fatalf("StartPostgres: %v", err)
	}
	var got []string
	for _, c := range fake.Calls {
		got = append(got, c.Args[0])
	}
	if want := []string{"run", "rm", "run", "exec", "exec"}; !slices.Equal(got, want) {
		t.Errorf("docker subcommands = %v, want %v", got, want)
	}
}

func TestStartPostgresDockerMissing(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", nil, execx.FakeResponse{Err: &exec.Error{Name: "docker", Err: exec.ErrNotFound}})

	_, err := StartPostgres(context.Background(), testOptions(t, fake))
	if !errors.Is(err, ErrDockerMissing) {
		t.Fatalf("err = %v, want ErrDockerMissing", err)
	}
}

func TestPostgresEnv(t *testing.T) {
	p := &Postgres{Name: ContainerName("r1"), SocketDir: filepath.Join("/s/runs/r1", "pg")}
	env := p.Env()
	for _, want := range []string{
		"DATABASE_URL=postgresql://postgres@/postgres?host=/s/runs/r1/pg",
		"PGHOST=/s/runs/r1/pg",
		"PGUSER=postgres",
		"PGDATABASE=postgres",
	} {
		if !slices.Contains(env, want) {
			t.Errorf("Env() = %v, missing %q", env, want)
		}
	}
}

func TestSocketDirMode(t *testing.T) {
	old := syscall.Umask(0o022)
	defer syscall.Umask(old)

	fake := &execx.Fake{}
	onFinalServer(fake)
	fake.On("docker", nil, execx.FakeResponse{})
	o := testOptions(t, fake)
	if _, err := StartPostgres(context.Background(), o); err != nil {
		t.Fatalf("StartPostgres: %v", err)
	}
	fi, err := os.Stat(filepath.Join(o.RunDir, "pg"))
	if err != nil {
		t.Fatal(err)
	}
	if !fi.IsDir() || fi.Mode().Perm() != 0o777 {
		t.Errorf("socket dir mode = %v, want drwxrwxrwx", fi.Mode())
	}
}

func TestStopIdempotent(t *testing.T) {
	fake := &execx.Fake{}
	stops := 0
	fake.On("docker", []string{"rm", "-f", "hookci-svc-r1-postgres"}, execx.FakeResponse{Fn: func(c execx.Cmd) error {
		stops++
		if stops == 2 {
			msg := "Error response from daemon: No such container: hookci-svc-r1-postgres"
			_, _ = c.Stderr.Write([]byte(msg))
			return &execx.ExitError{Code: 1, Stderr: msg}
		}
		return nil
	}})
	p := &Postgres{Name: ContainerName("r1"), SocketDir: "/s/runs/r1/pg", docker: Docker{Runner: fake}}

	for i := range 2 {
		if err := p.Stop(context.Background()); err != nil {
			t.Fatalf("Stop #%d: %v", i+1, err)
		}
	}
	if stops != 2 {
		t.Errorf("docker rm -f calls = %d, want 2", stops)
	}
	if err := (*Postgres)(nil).Stop(context.Background()); err != nil {
		t.Errorf("nil Stop = %v, want nil", err)
	}
}

func TestStopReportsOtherErrors(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", []string{"rm"}, execx.FakeResponse{Code: 1, Stderr: "Cannot connect to the Docker daemon"})
	p := &Postgres{Name: ContainerName("r1"), docker: Docker{Runner: fake}}
	if err := p.Stop(context.Background()); err == nil {
		t.Error("Stop ignored a daemon error")
	}
}

func TestRejectBadImage(t *testing.T) {
	fake := &execx.Fake{}
	o := testOptions(t, fake)
	for _, image := range []string{
		"postgres:16; rm -rf /", "Postgres:16", "--privileged",
		"postgres", "postgres.evil.example/x:1", "postgrest/postgrest:v12", "postgresx/miner:latest",
		"ghcr.io/library/postgres:16", "postgres:16 ",
	} {
		o.Image = image
		if _, err := StartPostgres(context.Background(), o); err == nil {
			t.Errorf("image %q accepted", image)
		}
	}
	if len(fake.Calls) != 0 {
		t.Errorf("docker called for a bad image: %v", fake.Calls)
	}
}

func TestAcceptAllowedImages(t *testing.T) {
	digest := "@sha256:" + strings.Repeat("a", 64)
	for _, image := range []string{"postgres:16", "library/postgres:16-alpine", "docker.io/library/postgres:17.2", "postgres" + digest, "postgres:16" + digest, "pgvector/pgvector:pg16"} {
		fake := &execx.Fake{}
		fake.On("docker", []string{"run"}, execx.FakeResponse{})
		onFinalServer(fake)
		fake.On("docker", []string{"exec"}, execx.FakeResponse{})
		o := testOptions(t, fake)
		o.Image = image
		if _, err := StartPostgres(context.Background(), o); err != nil {
			t.Errorf("image %q: %v", image, err)
		}
	}
}

// hangingExec blocks every docker exec until its context ends, like a
// stalled daemon; other docker calls go to the fake.
type hangingExec struct{ *execx.Fake }

func (h hangingExec) Run(ctx context.Context, c execx.Cmd) error {
	if len(c.Args) > 0 && c.Args[0] == "exec" {
		<-ctx.Done()
		return ctx.Err()
	}
	return h.Fake.Run(ctx, c)
}

func TestStartPostgresTimeoutWhileExecHangs(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", []string{"run"}, execx.FakeResponse{})
	fake.On("docker", []string{"logs"}, execx.FakeResponse{})
	fake.On("docker", []string{"rm"}, execx.FakeResponse{})
	o := PostgresOptions{
		RunID: "01HX", RunDir: t.TempDir(), CPUs: 1, MemoryBytes: 1 << 30,
		ReadyTimeout: 50 * time.Millisecond,
		Docker:       Docker{Runner: hangingExec{fake}},
	}
	start := time.Now()
	_, err := StartPostgres(context.Background(), o)
	if !errors.Is(err, ErrNotReady) {
		t.Fatalf("err = %v, want ErrNotReady", err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("StartPostgres took %s with a 50ms ready timeout", d)
	}
}

func TestBuildRunArgvDropsPrivileges(t *testing.T) {
	argv := strings.Join(BuildRunArgv(PostgresOptions{RunID: "r1", RunDir: "/s/runs/r1", CPUs: 2, MemoryBytes: 4 << 30}), " ")
	for _, want := range []string{"--pids-limit 512", "--security-opt no-new-privileges", "--cap-drop ALL"} {
		if !strings.Contains(argv, want) {
			t.Errorf("argv lacks %q: %s", want, argv)
		}
	}
}
