// Package e2e_test runs `hookci run` end to end on examples/node-app.
package e2e_test

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/cli"
	"github.com/KCuppens/hookci/agent/internal/detect"
	"github.com/KCuppens/hookci/agent/internal/egress"
	"github.com/KCuppens/hookci/agent/internal/executor"
	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/isolation"
	"github.com/KCuppens/hookci/agent/internal/logpipe"
	"github.com/KCuppens/hookci/agent/internal/netns"
	"github.com/KCuppens/hookci/agent/internal/source"
)

var wantJobs = []string{"lint", "test", "typecheck"}

// markerRE matches the timing lines scripts/timed.js prints. npm and
// node --test may prefix them, so it is not anchored.
var markerRE = regexp.MustCompile(`HOOKCI_E2E (\S+) (start|end) (\d+)`)

// interval is when a job's timed body ran, in Unix milliseconds.
type interval struct {
	job        string
	start, end int64
}

type fakeProxy struct{}

func (fakeProxy) Port() int    { return 0 }
func (fakeProxy) Close() error { return nil }

// hermeticDeps run jobs as process groups of the test with no egress proxy,
// no network namespaces and faked recovery host commands.
func hermeticDeps(t *testing.T, wd string) func(cli.Globals, io.Writer) cli.Deps {
	return func(g cli.Globals, _ io.Writer) cli.Deps {
		host := &execx.Fake{}
		host.On("pkill", nil, execx.FakeResponse{Code: 1})
		host.On("docker", nil, execx.FakeResponse{})
		return cli.Deps{
			Globals: g,
			Isolation: func(name string) (isolation.Isolation, []string, error) {
				if name != "none" {
					return nil, nil, errors.New("only isolation none in e2e tests")
				}
				return &isolation.None{Grace: time.Second, Warn: func(string) {}}, nil, nil
			},
			Clock: time.Now,
			Getwd: func() (string, error) { return wd, nil },
			Hooks: executor.Hooks{
				StartProxy: func(context.Context, egress.Options) (executor.Proxy, error) { return fakeProxy{}, nil },
			},
			Host:  host,
			Netns: &netns.Manager{NetnsDir: t.TempDir(), LookPath: func(string) (string, error) { return "", exec.ErrNotFound }},
			After: time.After,
		}
	}
}

// nodeApp copies examples/node-app into a new git repository with one
// commit and returns its path. It skips the test without node, npm or git.
func nodeApp(t *testing.T) string {
	t.Helper()
	for _, bin := range []string{"node", "npm", "git"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not in PATH", bin)
		}
	}
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	src := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "examples", "node-app")
	dst := filepath.Join(t.TempDir(), "node-app")
	err := filepath.WalkDir(src, func(path string, e fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if e.IsDir() && e.Name() == "node_modules" {
			return filepath.SkipDir
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if e.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
	if err != nil {
		t.Fatalf("copy examples/node-app: %v", err)
	}
	env := append(source.SafeGitEnv(t.TempDir()),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
	for _, args := range [][]string{
		{"init", "--quiet", "--initial-branch=main"},
		{"add", "-A"},
		{"commit", "--quiet", "-m", "init"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dst
		cmd.Env = env
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	return dst
}

// runNodeApp runs `hookci run` on repo with slots and returns the timed
// interval of every job, sorted by start.
func runNodeApp(t *testing.T, repo string, slots int) []interval {
	t.Helper()
	state := filepath.Join(t.TempDir(), "state")
	var stdout, stderr bytes.Buffer
	args := []string{"--state-dir", state, "--isolation", "none", "--slots", strconv.Itoa(slots), "run"}
	if code := cli.MainWithDeps(args, &stdout, &stderr, hermeticDeps(t, repo)); code != cli.ExitOK {
		t.Fatalf("hookci run = %d, want %d\nstdout:\n%s\nstderr:\n%s", code, cli.ExitOK, &stdout, &stderr)
	}
	if !strings.Contains(stdout.String(), "success (3 jobs") {
		t.Errorf("stdout lacks the success summary of 3 jobs:\n%s", &stdout)
	}
	runs, err := os.ReadDir(filepath.Join(state, "runs"))
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 {
		t.Fatalf("got %d run dirs, want 1", len(runs))
	}
	runDir := filepath.Join(state, "runs", runs[0].Name())
	var got []interval
	for _, job := range wantJobs {
		got = append(got, jobInterval(t, logpipe.LogPath(runDir, job), job))
	}
	sort.Slice(got, func(i, j int) bool { return got[i].start < got[j].start })
	return got
}

// jobInterval reads the start and end markers of job from its log.
func jobInterval(t *testing.T, path, job string) interval {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("log of %s: %v", job, err)
	}
	defer f.Close()
	iv := interval{job: job}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		m := markerRE.FindStringSubmatch(sc.Text())
		if m == nil || m[1] != job {
			continue
		}
		ms, err := strconv.ParseInt(m[3], 10, 64)
		if err != nil {
			t.Fatalf("log of %s: %v", job, err)
		}
		if m[2] == "start" {
			iv.start = ms
		} else {
			iv.end = ms
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	if iv.start == 0 || iv.end == 0 || iv.end < iv.start {
		data, _ := os.ReadFile(path)
		t.Fatalf("log of %s has no start/end markers:\n%s", job, data)
	}
	return iv
}

// maxConcurrent is the most intervals that ran at one instant. An end at
// the same millisecond as a start does not overlap it.
func maxConcurrent(ivs []interval) int {
	type event struct {
		at    int64
		delta int
	}
	var events []event
	for _, iv := range ivs {
		events = append(events, event{iv.start, 1}, event{iv.end, -1})
	}
	sort.Slice(events, func(i, j int) bool {
		if events[i].at != events[j].at {
			return events[i].at < events[j].at
		}
		return events[i].delta < events[j].delta
	})
	cur, peak := 0, 0
	for _, e := range events {
		cur += e.delta
		peak = max(peak, cur)
	}
	return peak
}

func TestNodeAppEndToEnd(t *testing.T) {
	repo := nodeApp(t)

	t.Run("detect", func(t *testing.T) {
		det, err := detect.DetectDir(repo)
		if err != nil {
			t.Fatalf("DetectDir: %v", err)
		}
		if det.Config.HookCIConfig.Checks == nil {
			t.Fatal("no checks detected")
		}
		var got []string
		for name := range det.Config.HookCIConfig.Checks.Jobs {
			got = append(got, name)
		}
		slices.Sort(got)
		if !reflect.DeepEqual(got, wantJobs) {
			t.Fatalf("detected jobs = %v, want %v", got, wantJobs)
		}
	})

	t.Run("parallel", func(t *testing.T) {
		ivs := runNodeApp(t, repo, 3)
		if peak := maxConcurrent(ivs); peak < 2 {
			t.Errorf("with 3 slots no two jobs overlapped: %+v", ivs)
		}
	})
}

func TestNodeAppSlotsRespected(t *testing.T) {
	repo := nodeApp(t)
	for _, slots := range []int{1, 2} {
		t.Run("slots="+strconv.Itoa(slots), func(t *testing.T) {
			ivs := runNodeApp(t, repo, slots)
			if peak := maxConcurrent(ivs); peak > slots {
				t.Errorf("%d jobs overlapped with %d slots: %+v", peak, slots, ivs)
			}
		})
	}
}
