package cli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/selfupdate"
	"github.com/KCuppens/zerocideploy/agent/internal/systemd"
	"github.com/KCuppens/zerocideploy/agent/internal/version"
)

type acceptAll struct{}

func (acceptAll) VerifyBlob([]byte, []byte) error { return nil }

// fakeReleases serves release tag laid out like GitHub releases, with a
// tarball holding binary for this GOARCH.
func fakeReleases(t *testing.T, tag string, binary []byte) *httptest.Server {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	if err := tw.WriteHeader(&tar.Header{Name: "zeroci", Mode: 0o755, Size: int64(len(binary)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	tw.Write(binary)
	tw.Close()
	zw.Close()
	files := map[string][]byte{
		selfupdate.AssetName(tag, runtime.GOARCH): buf.Bytes(),
		selfupdate.TrustedRootName:                []byte(`{"root":"refreshed"}`),
		selfupdate.BundleName:                     []byte(`{}`),
	}
	var sums strings.Builder
	for name, b := range files {
		d := sha256.Sum256(b)
		sums.WriteString(hex.EncodeToString(d[:]) + "  " + name + "\n")
	}
	files[selfupdate.SumsName] = []byte(sums.String())

	mux := http.NewServeMux()
	mux.HandleFunc("/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/releases/tag/"+tag, http.StatusFound)
	})
	mux.HandleFunc("/releases/tag/", func(http.ResponseWriter, *http.Request) {})
	mux.HandleFunc("/releases/download/"+tag+"/", func(w http.ResponseWriter, r *http.Request) {
		b, ok := files[path.Base(r.URL.Path)]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(b)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

type upgradeEnv struct {
	bin, trustedRoot string
	svc              *fakeServices
}

func runUpgradeCLI(t *testing.T, srv *httptest.Server, current string, args ...string) (int, string, string, upgradeEnv) {
	t.Helper()
	old := version.Version
	version.Version = current
	t.Cleanup(func() { version.Version = old })
	dir := t.TempDir()
	env := upgradeEnv{
		bin:         filepath.Join(dir, "zeroci"),
		trustedRoot: filepath.Join(dir, selfupdate.TrustedRootName),
		svc:         &fakeServices{},
	}
	if err := os.WriteFile(env.bin, []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := MainWithDeps(append([]string{"upgrade"}, args...), &stdout, &stderr, func(g Globals, w io.Writer) Deps {
		d := DefaultDeps(g, w)
		d.Services = env.svc
		d.Releases = Releases{
			HTTP:        srv.Client(),
			BaseURL:     srv.URL + "/releases",
			BinPath:     func() (string, error) { return env.bin, nil },
			TrustedRoot: env.trustedRoot,
			NewVerifier: func([]byte) (selfupdate.Verifier, error) { return acceptAll{}, nil },
		}
		return d
	})
	return code, stdout.String(), stderr.String(), env
}

func TestUpgradeCheck(t *testing.T) {
	srv := fakeReleases(t, "v1.3.0", []byte("new binary"))
	tests := []struct {
		current string
		want    int
	}{
		{"1.2.9", ExitUpgradeAvailable},
		{"dev", ExitUpgradeAvailable},
		{"1.3.0", ExitOK},
		{"1.4.0", ExitOK},
	}
	for _, tt := range tests {
		code, stdout, stderr, env := runUpgradeCLI(t, srv, tt.current, "--check")
		if code != tt.want {
			t.Errorf("current %s: exit = %d, want %d; stderr %q", tt.current, code, tt.want, stderr)
		}
		if want := "current: " + tt.current + "\nlatest:  v1.3.0\n"; stdout != want {
			t.Errorf("current %s: stdout = %q, want %q", tt.current, stdout, want)
		}
		if b, _ := os.ReadFile(env.bin); string(b) != "old binary" {
			t.Errorf("--check replaced the binary")
		}
	}
}

func TestUpgradeAppliesAndRestarts(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("releases are linux only")
	}
	srv := fakeReleases(t, "v1.3.0", []byte("new binary"))
	code, stdout, stderr, env := runUpgradeCLI(t, srv, "1.2.0")
	if code != ExitOK {
		t.Fatalf("exit = %d; stderr %q", code, stderr)
	}
	if b, _ := os.ReadFile(env.bin); string(b) != "new binary" {
		t.Fatalf("binary = %q", b)
	}
	if !slices.Equal(env.svc.restarted, []string{systemd.AllAgentUnits}) {
		t.Fatalf("restarted = %v", env.svc.restarted)
	}
	if stdout != "upgraded 1.2.0 -> v1.3.0\n" {
		t.Fatalf("stdout = %q", stdout)
	}
}

func TestUpgradeRefusesDowngrade(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("releases are linux only")
	}
	srv := fakeReleases(t, "v1.0.0", []byte("old release"))
	code, _, stderr, env := runUpgradeCLI(t, srv, "1.2.0", "--version", "v1.0.0")
	if code != ExitInternal || !strings.Contains(stderr, "--allow-downgrade") {
		t.Fatalf("exit = %d, stderr %q; want %d and a downgrade refusal", code, stderr, ExitInternal)
	}
	if b, _ := os.ReadFile(env.bin); string(b) != "old binary" {
		t.Fatalf("binary = %q", b)
	}

	code, _, stderr, env = runUpgradeCLI(t, srv, "1.2.0", "--version", "v1.0.0", "--allow-downgrade")
	if code != ExitOK {
		t.Fatalf("--allow-downgrade: exit = %d; stderr %q", code, stderr)
	}
	if b, _ := os.ReadFile(env.bin); string(b) != "old release" {
		t.Fatalf("binary = %q", b)
	}
}

func TestUpgradeRefreshTrustRoot(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("releases are linux only")
	}
	srv := fakeReleases(t, "v1.3.0", []byte("new binary"))
	code, _, stderr, env := runUpgradeCLI(t, srv, "1.3.0", "--refresh-trust-root")
	if code != ExitOK {
		t.Fatalf("exit = %d; stderr %q", code, stderr)
	}
	if b, _ := os.ReadFile(env.trustedRoot); string(b) != `{"root":"refreshed"}` {
		t.Fatalf("trusted root = %q", b)
	}
	if b, _ := os.ReadFile(env.bin); string(b) != "old binary" {
		t.Fatalf("refresh replaced the binary")
	}
	if len(env.svc.restarted) != 0 {
		t.Fatalf("refresh restarted %v", env.svc.restarted)
	}
}
