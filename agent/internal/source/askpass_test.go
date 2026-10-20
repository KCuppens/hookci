package source

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

const testToken = "ghs_s3cretInstallationToken"

// privateDir returns a 0700 directory the test user owns.
func privateDir(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "tmp")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

func runAskpass(prompt string) (int, string) {
	var out, errOut bytes.Buffer
	code := RunAskpass([]string{prompt}, &out, &errOut)
	return code, out.String()
}

func TestAskpassFlow(t *testing.T) {
	dir := privateDir(t)
	path, cleanup, err := WriteAskpassFile(dir, testToken)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(path) != dir {
		t.Fatalf("file %s not in %s", path, dir)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600", fi.Mode().Perm())
	}
	t.Setenv("ZEROCI_ASKPASS_FILE", path)

	if code, out := runAskpass("Password for 'https://github.com': "); code != 0 || out != testToken+"\n" {
		t.Fatalf("Password prompt = %d %q", code, out)
	}
	if code, out := runAskpass("Username for 'https://github.com': "); code != 0 || out != "x-access-token\n" {
		t.Fatalf("Username prompt = %d %q", code, out)
	}
	if code, out := runAskpass("Are you sure you want to continue connecting (yes/no)? "); code != 1 || out != "" {
		t.Fatalf("other prompt = %d %q", code, out)
	}
	if code := RunAskpass(nil, &bytes.Buffer{}, &bytes.Buffer{}); code != 1 {
		t.Fatalf("no prompt = %d", code)
	}

	cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("file still present after cleanup: %v", err)
	}
	cleanup()
	if code, out := runAskpass("Password for 'https://github.com': "); code != 1 || out != "" {
		t.Fatalf("after cleanup = %d %q", code, out)
	}
}

func TestAskpassRefusesLoosePerms(t *testing.T) {
	path, cleanup, err := WriteAskpassFile(privateDir(t), testToken)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZEROCI_ASKPASS_FILE", path)
	for _, prompt := range []string{"Password for 'https://github.com': ", "Username for 'https://github.com': "} {
		if code, out := runAskpass(prompt); code != 1 || out != "" {
			t.Fatalf("%q with 0644 file = %d %q, want 1 and no stdout", prompt, code, out)
		}
	}
}

func TestAskpassRefusesSymlink(t *testing.T) {
	dir := privateDir(t)
	path, cleanup, err := WriteAskpassFile(dir, testToken)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	link := filepath.Join(dir, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZEROCI_ASKPASS_FILE", link)
	if code, out := runAskpass("Password for 'https://github.com': "); code != 1 || out != "" {
		t.Fatalf("symlinked file = %d %q, want 1 and no stdout", code, out)
	}
}

func TestWriteAskpassFileNeedsPrivateDir(t *testing.T) {
	shared := privateDir(t)
	if err := os.Chmod(shared, 0o1777); err != nil {
		t.Fatal(err)
	}
	if _, _, err := WriteAskpassFile(shared, testToken); err == nil {
		t.Fatal("WriteAskpassFile accepted a world-writable dir")
	}
	if _, _, err := WriteAskpassFile(privateDir(t), "a\nb"); err == nil {
		t.Fatal("WriteAskpassFile accepted a multi-line token")
	}
	entries, err := os.ReadDir(shared)
	if err != nil || len(entries) != 0 {
		t.Fatalf("shared dir entries = %v, %v", entries, err)
	}
}

func TestAskpassEnvNoToken(t *testing.T) {
	path, cleanup, err := WriteAskpassFile(privateDir(t), testToken)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	env := AskpassEnv("/usr/local/bin/zeroci", path)
	want := []string{"GIT_ASKPASS=/usr/local/bin/zeroci", "ZEROCI_ASKPASS=1", "ZEROCI_ASKPASS_FILE=" + path}
	if !slices.Equal(env, want) {
		t.Fatalf("AskpassEnv = %q, want %q", env, want)
	}

	f := &execx.Fake{}
	f.On("git", nil, execx.FakeResponse{})
	m := NewMirrors(filepath.Join(t.TempDir(), "mirrors"), Git{Runner: f})
	ctx := context.Background()
	if _, err := m.Ensure(ctx, "o/r", "https://github.com/o/r.git"); err != nil {
		t.Fatal(err)
	}
	if err := m.Fetch(ctx, "o/r", []string{testSHA, "+refs/pull/3/head:refs/zeroci/pull/3"}, env); err != nil {
		t.Fatal(err)
	}
	if len(f.Calls) == 0 {
		t.Fatal("no git calls recorded")
	}
	for _, c := range f.Calls {
		for _, s := range slices.Concat(c.Args, c.Env) {
			if strings.Contains(s, testToken) {
				t.Fatalf("token leaked into git call: %q", s)
			}
		}
	}
	if fetch := f.Calls[len(f.Calls)-1]; !slices.Contains(fetch.Env, "ZEROCI_ASKPASS_FILE="+path) {
		t.Fatalf("fetch env lacks askpass file: %q", fetch.Env)
	}
}
