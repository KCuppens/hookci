package source

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/askpass"
)

// TestMain lets the test binary stand in for the hookci binary as git's
// GIT_ASKPASS helper, the way cmd/hookci dispatches it.
func TestMain(m *testing.M) {
	if os.Getenv(askpass.EnvSock) != "" && len(os.Args) == 2 {
		os.Exit(askpass.Main(os.Args, os.Stdout))
	}
	os.Exit(m.Run())
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func assertEmptyDir(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("%s still holds %v", dir, entries)
	}
}

func TestHubSourcePRRef(t *testing.T) {
	repo := newRealRepo(t)
	base := plainGit(t, repo, "rev-parse", "HEAD~1")
	mainSHA := plainGit(t, repo, "rev-parse", "HEAD")
	plainGit(t, repo, "checkout", "--quiet", "-b", "feature")
	if err := os.WriteFile(filepath.Join(repo, "app.txt"), []byte("three\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	plainGit(t, repo, "commit", "--quiet", "-am", "three")
	head := plainGit(t, repo, "rev-parse", "HEAD")
	plainGit(t, repo, "update-ref", "refs/pull/7/head", head)
	plainGit(t, repo, "checkout", "--quiet", "main")
	plainGit(t, repo, "branch", "--quiet", "-D", "feature")
	plainGit(t, repo, "config", "uploadpack.allowAnySHA1InWant", "true")

	work := t.TempDir()
	h := &HubSource{
		Tokens: func(context.Context, string) (string, error) {
			t.Error("a file:// fetch asked for a token")
			return "", errors.New("unexpected")
		},
		WorkRoot:  work,
		RemoteURL: func(string) string { return "file://" + repo },
	}
	req := Request{Repo: "o/r", SHA: head, Ref: "refs/pull/7/head", BaseSHA: base, RunID: "run-1"}
	dir := filepath.Join(t.TempDir(), "src")
	co, err := h.Checkout(context.Background(), req, dir)
	if err != nil {
		t.Fatal(err)
	}
	if co.SHA != head || co.Dir != dir || co.Ref != req.Ref || co.Repo != "o/r" {
		t.Errorf("checkout = %+v", co)
	}
	if got := plainGit(t, dir, "rev-parse", "HEAD"); got != head {
		t.Errorf("HEAD = %s, want %s", got, head)
	}
	if got := readFile(t, filepath.Join(dir, "app.txt")); got != "three\n" {
		t.Errorf("app.txt = %q, want the PR head content", got)
	}
	if got := readFile(t, filepath.Join(co.BaseDir, "app.txt")); got != "one\n" {
		t.Errorf("base app.txt = %q, want the base content", got)
	}
	co.Release()
	co.Release()
	assertEmptyDir(t, work)
	if _, err := os.Stat(filepath.Join(dir, "app.txt")); err != nil {
		t.Errorf("Release removed the checkout: %v", err)
	}

	wrong := req
	wrong.SHA = mainSHA
	_, err = h.Checkout(context.Background(), wrong, filepath.Join(t.TempDir(), "src"))
	if !errors.Is(err, ErrSHAMismatch) {
		t.Fatalf("wrong sha: err = %v, want ErrSHAMismatch", err)
	}
	assertEmptyDir(t, work)
}

// fakeGitScript logs every invocation's argv and env to log/calls, acts out
// init, fetch and rev-parse, and on fetch asks GIT_ASKPASS for credentials
// the way git does, saving the answers to log/user and log/pass.
const fakeGitScript = `#!/bin/sh
log=LOGDIR
printf 'argv:' >> "$log/calls"
for a in "$@"; do printf ' %s' "$a" >> "$log/calls"; done
printf '\n' >> "$log/calls"
env >> "$log/calls"
printf 'end\n' >> "$log/calls"
while [ $# -gt 0 ]; do
	case "$1" in
	-c|-C) shift 2 ;;
	*) break ;;
	esac
done
case "$1" in
init) mkdir -p "$3" ;;
fetch)
	"$GIT_ASKPASS" "Username for 'https://github.com': " >> "$log/user" || exit 1
	"$GIT_ASKPASS" "Password for 'https://x-access-token@github.com': " >> "$log/pass" || exit 1
	;;
rev-parse) echo HEADSHA ;;
esac
`

func TestHubSourceTokenNotInEnvOrArgs(t *testing.T) {
	const tok = "ghs_fakeInstallationToken0123456789"
	logDir := t.TempDir()
	bin := filepath.Join(t.TempDir(), "git")
	script := strings.NewReplacer("LOGDIR", logDir, "HEADSHA", testSHA).Replace(fakeGitScript)
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	work := t.TempDir()
	h := &HubSource{
		Git: bin,
		Tokens: func(_ context.Context, runID string) (string, error) {
			calls.Add(1)
			if runID != "run-1" {
				t.Errorf("token requested for %q", runID)
			}
			return tok, nil
		},
		WorkRoot: work,
	}
	req := Request{Repo: "o/r", SHA: testSHA, Ref: "refs/heads/main", BaseSHA: strings.Repeat("b", 40), RunID: "run-1"}
	co, err := h.Checkout(context.Background(), req, filepath.Join(t.TempDir(), "src"))
	if err != nil {
		t.Fatal(err)
	}
	defer co.Release()

	if got := readFile(t, filepath.Join(logDir, "pass")); got != strings.Repeat(tok+"\n", 2) {
		t.Fatalf("askpass passwords = %q, want the token for both fetches", got)
	}
	if got := readFile(t, filepath.Join(logDir, "user")); got != strings.Repeat(askpass.User+"\n", 2) {
		t.Errorf("askpass usernames = %q", got)
	}
	if n := calls.Load(); n != 1 {
		t.Errorf("Tokens called %d times for two fetches, want 1", n)
	}

	log := readFile(t, filepath.Join(logDir, "calls"))
	if strings.Contains(log, tok) {
		t.Fatal("token appears in a git invocation's argv or env")
	}
	invocations := strings.Split(strings.TrimSuffix(log, "end\n"), "end\n")
	fetches := 0
	for _, inv := range invocations {
		argv, _, _ := strings.Cut(inv, "\n")
		isFetch := strings.Contains(argv, " fetch ")
		if isFetch {
			fetches++
			if !strings.Contains(argv, " https://github.com/o/r.git "+testSHA) && !strings.Contains(argv, " https://github.com/o/r.git "+req.BaseSHA) {
				t.Errorf("fetch argv = %s", argv)
			}
		}
		if hasSock := strings.Contains(inv, "\n"+askpass.EnvSock+"="); hasSock != isFetch {
			t.Errorf("%s: has %s = %v, want it only on fetch", argv, askpass.EnvSock, hasSock)
		}
	}
	if len(invocations) != 7 || fetches != 2 {
		t.Errorf("%d git calls with %d fetches, want init, fetch, checkout, rev-parse for head and init, fetch, checkout for base", len(invocations), fetches)
	}
	if v := os.Getenv(askpass.EnvSock); v != "" {
		t.Errorf("agent process env has %s=%s", askpass.EnvSock, v)
	}
	entries, err := os.ReadDir(work)
	if err != nil || len(entries) != 1 {
		t.Fatalf("work root = %v, %v; want one scratch dir", entries, err)
	}
	if _, err := os.Stat(filepath.Join(work, entries[0].Name(), "a.sock")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("askpass socket outlived the fetch: %v", err)
	}
}
