package caddy

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/proxy"
	"github.com/KCuppens/zerocideploy/agent/internal/testutil"
)

// scriptedRunner records every argv and fails the call numbers in fail
// (1-based) with exit status 1 and the mapped stderr. When file is set it
// also records the file's contents at each call.
type scriptedRunner struct {
	file  string
	fail  map[int]string
	calls [][]string
	seen  []string
}

func (r *scriptedRunner) Run(_ context.Context, c execx.Cmd) error {
	r.calls = append(r.calls, append([]string{c.Name}, c.Args...))
	if r.file != "" {
		b, err := os.ReadFile(r.file)
		if err != nil {
			b = []byte("<missing>")
		}
		r.seen = append(r.seen, string(b))
	}
	stderr, ok := r.fail[len(r.calls)]
	if !ok {
		return nil
	}
	if c.Stderr != nil {
		_, _ = io.WriteString(c.Stderr, stderr)
	}
	return &execx.ExitError{Code: 1, Stderr: stderr}
}

func newAdapter(t *testing.T, r execx.Runner) *Adapter {
	t.Helper()
	a, err := New(r, "")
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func assertNoTemp(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".zeroci-tmp-") {
			t.Errorf("temp file %s left behind", e.Name())
		}
	}
}

func TestRender(t *testing.T) {
	a := newAdapter(t, &scriptedRunner{})
	got, err := a.Render(proxy.RouteSpec{Repo: "myapp", Env: "production", Color: "green", UpstreamHost: "127.0.0.1", Port: 20001})
	if err != nil {
		t.Fatal(err)
	}
	testutil.GoldenFile(t, filepath.Join("testdata", "route_golden.caddy"), got)
}

func TestRender_RejectsBadInput(t *testing.T) {
	a := newAdapter(t, &scriptedRunner{})
	for _, tc := range []struct {
		name string
		host string
		port int
		want string
	}{
		{"port 0", "127.0.0.1", 0, "port 0 is outside 1 to 65535"},
		{"port 70000", "127.0.0.1", 70000, "port 70000 is outside 1 to 65535"},
		{"host with newline", "127.0.0.1\nimport /etc/passwd", 20001, "must not contain whitespace"},
		{"host with space", "127.0.0.1 evil", 20001, "must not contain whitespace"},
		{"host with brace", "{env.HOST}", 20001, "must not contain whitespace"},
		{"empty host", "", 20001, "upstream_host is empty"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out, err := a.Render(proxy.RouteSpec{Repo: "myapp", Env: "production", Color: "blue", UpstreamHost: tc.host, Port: tc.port})
			if err == nil {
				t.Fatalf("Render = %q, want error", out)
			}
			if !strings.HasPrefix(err.Error(), "deployments.production.route: ") || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("err = %q, want prefix deployments.production.route: and %q", err, tc.want)
			}
		})
	}
}

// faultFS is the real filesystem except that temp file writes fail.
type faultFS struct{ osFS }

func (faultFS) CreateTemp(dir, pattern string) (tempFile, error) {
	f, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return nil, err
	}
	return failingWrite{f}, nil
}

type failingWrite struct{ *os.File }

func (failingWrite) Write([]byte) (int, error) { return 0, errors.New("no space left on device") }

func TestApply_AtomicRename(t *testing.T) {
	ctx := context.Background()

	t.Run("replaces existing file", func(t *testing.T) {
		dir := t.TempDir()
		file := filepath.Join(dir, "myapp-production.caddy")
		writeFile(t, file, "old route\n")

		prev, err := newAdapter(t, &scriptedRunner{}).Apply(ctx, file, []byte("new route\n"))
		if err != nil {
			t.Fatal(err)
		}
		if string(prev) != "old route\n" {
			t.Errorf("prev = %q, want old route", prev)
		}
		if got := readFile(t, file); got != "new route\n" {
			t.Errorf("file = %q, want new route", got)
		}
		info, err := os.Stat(file)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o644 {
			t.Errorf("mode = %v, want 0644", info.Mode().Perm())
		}
		assertNoTemp(t, dir)
	})

	t.Run("missing file returns nil prev", func(t *testing.T) {
		dir := t.TempDir()
		file := filepath.Join(dir, "route.caddy")
		prev, err := newAdapter(t, &scriptedRunner{}).Apply(ctx, file, []byte("new route\n"))
		if err != nil {
			t.Fatal(err)
		}
		if prev != nil {
			t.Errorf("prev = %q, want nil", prev)
		}
		if got := readFile(t, file); got != "new route\n" {
			t.Errorf("file = %q", got)
		}
		assertNoTemp(t, dir)
	})

	t.Run("empty existing file returns non-nil prev", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "route.caddy")
		writeFile(t, file, "")
		prev, err := newAdapter(t, &scriptedRunner{}).Apply(ctx, file, []byte("new route\n"))
		if err != nil {
			t.Fatal(err)
		}
		if prev == nil || len(prev) != 0 {
			t.Errorf("prev = %#v, want empty non-nil", prev)
		}
	})

	t.Run("write failure leaves target unchanged", func(t *testing.T) {
		dir := t.TempDir()
		file := filepath.Join(dir, "route.caddy")
		writeFile(t, file, "old route\n")
		a := newAdapter(t, &scriptedRunner{})
		a.FS = faultFS{}

		if _, err := a.Apply(ctx, file, []byte("new route\n")); err == nil || !strings.Contains(err.Error(), "no space left on device") {
			t.Fatalf("err = %v, want write failure", err)
		}
		if got := readFile(t, file); got != "old route\n" {
			t.Errorf("file = %q, want unchanged old route", got)
		}
		assertNoTemp(t, dir)
	})
}

func TestApplyAndReload_Success(t *testing.T) {
	file := filepath.Join(t.TempDir(), "route.caddy")
	writeFile(t, file, "old route\n")
	r := &scriptedRunner{file: file}

	if err := proxy.ApplyAndReload(context.Background(), newAdapter(t, r), file, []byte("new route\n")); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, file); got != "new route\n" {
		t.Errorf("file = %q, want new route", got)
	}
	if len(r.calls) != 1 || !slices.Equal(r.calls[0], defaultReloadArgv) {
		t.Errorf("calls = %q, want one default reload", r.calls)
	}
}

func TestApplyAndReload_RestoresOnReloadFailure(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "route.caddy")
	writeFile(t, file, "old route\n")
	r := &scriptedRunner{file: file, fail: map[int]string{1: "Error: adapting config: unrecognized directive"}}

	err := proxy.ApplyAndReload(context.Background(), newAdapter(t, r), file, []byte("new route\n"))
	if err == nil || !strings.Contains(err.Error(), "previous route restored") || !strings.Contains(err.Error(), "unrecognized directive") {
		t.Fatalf("err = %v, want previous route restored with reload stderr", err)
	}
	if got := readFile(t, file); got != "old route\n" {
		t.Errorf("file = %q, want previous bytes", got)
	}
	if len(r.calls) != 2 {
		t.Fatalf("reload calls = %d, want 2", len(r.calls))
	}
	if want := []string{"new route\n", "old route\n"}; !slices.Equal(r.seen, want) {
		t.Errorf("file at each reload = %q, want %q", r.seen, want)
	}
	assertNoTemp(t, dir)
}

func TestApplyAndReload_NoPrevRemovesFile(t *testing.T) {
	file := filepath.Join(t.TempDir(), "route.caddy")
	r := &scriptedRunner{fail: map[int]string{1: "reload refused"}}

	err := proxy.ApplyAndReload(context.Background(), newAdapter(t, r), file, []byte("new route\n"))
	if err == nil || !strings.Contains(err.Error(), "previous route restored") {
		t.Fatalf("err = %v, want previous route restored", err)
	}
	if _, err := os.Stat(file); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("stat route file: %v, want not exist", err)
	}
	if len(r.calls) != 2 {
		t.Errorf("reload calls = %d, want 2", len(r.calls))
	}
}

func TestApplyAndReload_RestoreReloadFails(t *testing.T) {
	file := filepath.Join(t.TempDir(), "route.caddy")
	writeFile(t, file, "old route\n")
	r := &scriptedRunner{fail: map[int]string{1: "first failure", 2: "second failure"}}

	err := proxy.ApplyAndReload(context.Background(), newAdapter(t, r), file, []byte("new route\n"))
	if err == nil {
		t.Fatal("want error")
	}
	for _, want := range []string{"route.reload", "first failure", "second failure"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("err = %q, want it to contain %q", err, want)
		}
	}
	if strings.Contains(err.Error(), "previous route restored") {
		t.Errorf("err = %q claims the previous route was restored", err)
	}
	if got := readFile(t, file); got != "old route\n" {
		t.Errorf("file = %q, want previous bytes", got)
	}
}

func TestReload_ErrorIncludesStderrHead(t *testing.T) {
	stderr := strings.Repeat("x", 600) + "TAIL"
	r := &scriptedRunner{fail: map[int]string{1: stderr}}
	a, err := New(r, "systemctl reload caddy")
	if err != nil {
		t.Fatal(err)
	}

	err = a.Reload(context.Background())
	if err == nil {
		t.Fatal("want error")
	}
	msg := err.Error()
	if !strings.Contains(msg, `"systemctl reload caddy"`) || !strings.Contains(msg, "exit status 1") {
		t.Errorf("err = %q, want command and exit status", msg)
	}
	if !strings.Contains(msg, strings.Repeat("x", 512)) || strings.Contains(msg, strings.Repeat("x", 513)) || strings.Contains(msg, "TAIL") {
		t.Errorf("err carries %d bytes of x, want exactly the first 512 bytes of stderr", strings.Count(msg, "x"))
	}
}

func TestNew_ParsesReloadArgv(t *testing.T) {
	for _, tc := range []struct {
		reload string
		want   []string
	}{
		{"", []string{"caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"}},
		{"systemctl reload caddy", []string{"systemctl", "reload", "caddy"}},
		{`"/usr/local/bin/caddy" reload --config /etc/caddy/Caddyfile`, []string{"/usr/local/bin/caddy", "reload", "--config", "/etc/caddy/Caddyfile"}},
	} {
		t.Run(tc.reload, func(t *testing.T) {
			a, err := New(&scriptedRunner{}, tc.reload)
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(a.ReloadArgv, tc.want) {
				t.Errorf("ReloadArgv = %q, want %q", a.ReloadArgv, tc.want)
			}
		})
	}

	for _, reload := range []string{`caddy reload --config "/etc/caddy/Caddyfile`, `'' reload`, "\\\n"} {
		if _, err := New(&scriptedRunner{}, reload); err == nil || !strings.Contains(err.Error(), "route.reload") {
			t.Errorf("New(%q): err = %v, want route.reload error", reload, err)
		}
	}
}

func TestSplitArgv(t *testing.T) {
	for _, tc := range []struct {
		in      string
		want    []string
		wantErr string
	}{
		{in: "  caddy\treload \n --force ", want: []string{"caddy", "reload", "--force"}},
		{in: `sh -c 'caddy reload; echo $HOME'`, want: []string{"sh", "-c", "caddy reload; echo $HOME"}},
		{in: `a "b \"c\" \\ \$d \x"`, want: []string{"a", `b "c" \ $d \x`}},
		{in: `a\ b c`, want: []string{"a b", "c"}},
		{in: `x"y"'z' ""`, want: []string{"xyz", ""}},
		{in: "a \\\nb", want: []string{"a", "b"}},
		{in: `a 'b`, wantErr: "unterminated single quote"},
		{in: `a "b`, wantErr: "unterminated double quote"},
		{in: `a b\`, wantErr: "trailing backslash"},
	} {
		t.Run(tc.in, func(t *testing.T) {
			got, err := splitArgv(tc.in)
			if tc.wantErr != "" {
				if err == nil || err.Error() != tc.wantErr {
					t.Fatalf("splitArgv = %q, %v; want error %q", got, err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(got, tc.want) {
				t.Errorf("splitArgv = %q, want %q", got, tc.want)
			}
		})
	}
}
