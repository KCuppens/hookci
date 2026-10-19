package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

type fakeVerifier struct {
	err error
}

func (f fakeVerifier) VerifyBlob(sums, bundle []byte) error { return f.err }

// releaseServer serves one tagged release laid out like GitHub releases.
type releaseServer struct {
	*httptest.Server
	tag   string
	files map[string][]byte
}

func newReleaseServer(t *testing.T, tag string, binary []byte) *releaseServer {
	t.Helper()
	rs := &releaseServer{tag: tag, files: map[string][]byte{}}
	archive := tarball(t, binary)
	asset := AssetName(tag, "amd64")
	rs.files[asset] = archive
	rs.files[TrustedRootName] = []byte(`{"root":"new"}`)
	rs.files[SumsName] = []byte(sumLine(archive, asset) + sumLine(rs.files[TrustedRootName], TrustedRootName))
	rs.files[BundleName] = []byte(`{"bundle":true}`)
	mux := http.NewServeMux()
	mux.HandleFunc("/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/releases/tag/"+rs.tag, http.StatusFound)
	})
	mux.HandleFunc("/releases/tag/", func(w http.ResponseWriter, r *http.Request) {})
	mux.HandleFunc("/releases/download/", func(w http.ResponseWriter, r *http.Request) {
		b, ok := rs.files[filepath.Base(r.URL.Path)]
		if !ok || filepath.Base(filepath.Dir(r.URL.Path)) != rs.tag {
			http.NotFound(w, r)
			return
		}
		w.Write(b)
	})
	rs.Server = httptest.NewServer(mux)
	t.Cleanup(rs.Close)
	return rs
}

func sumLine(b []byte, name string) string {
	d := sha256.Sum256(b)
	return hex.EncodeToString(d[:]) + "  " + name + "\n"
}

func tarball(t *testing.T, binary []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for name, body := range map[string][]byte{"LICENSE": []byte("license"), "zeroci": binary} {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

type harness struct {
	u        *Updater
	bin      string
	restarts int
}

func newHarness(t *testing.T, rs *releaseServer, v Verifier) *harness {
	t.Helper()
	h := &harness{bin: filepath.Join(t.TempDir(), "zeroci")}
	if err := os.WriteFile(h.bin, []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	h.u = &Updater{
		HTTP:     rs.Client(),
		BaseURL:  rs.URL + "/releases",
		Verifier: v,
		BinPath:  h.bin,
		Arch:     "amd64",
		Current:  "v1.0.0",
		Restart: func(context.Context) error {
			h.restarts++
			return nil
		},
	}
	return h
}

func (h *harness) assertUnchanged(t *testing.T) {
	t.Helper()
	got, err := os.ReadFile(h.bin)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "old binary" {
		t.Fatalf("binary = %q, want original", got)
	}
	if _, err := os.Stat(h.bin + ".new"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf(".new left behind: %v", err)
	}
	if h.restarts != 0 {
		t.Fatalf("restarts = %d, want 0", h.restarts)
	}
}

func TestLatestAndApply(t *testing.T) {
	rs := newReleaseServer(t, "v1.2.3", []byte("new binary"))
	h := newHarness(t, rs, fakeVerifier{})

	r, err := h.u.Latest(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := h.u.Tagged("v1.2.3")
	if r != want {
		t.Fatalf("Latest = %+v, want %+v", r, want)
	}
	if err := h.u.Apply(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(h.bin)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new binary" {
		t.Fatalf("binary = %q", got)
	}
	fi, err := os.Stat(h.bin)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o755 {
		t.Fatalf("mode = %v", fi.Mode())
	}
	if h.restarts != 1 {
		t.Fatalf("restarts = %d, want 1", h.restarts)
	}
}

func TestApplyChecksumMismatch(t *testing.T) {
	rs := newReleaseServer(t, "v1.2.3", []byte("new binary"))
	rs.files[AssetName("v1.2.3", "amd64")] = tarball(t, []byte("tampered"))
	h := newHarness(t, rs, fakeVerifier{})
	err := h.u.Apply(context.Background(), h.u.Tagged("v1.2.3"))
	if !errors.Is(err, ErrChecksum) {
		t.Fatalf("err = %v, want ErrChecksum", err)
	}
	h.assertUnchanged(t)
}

func TestApplyAssetNotListed(t *testing.T) {
	rs := newReleaseServer(t, "v1.2.3", []byte("new binary"))
	h := newHarness(t, rs, fakeVerifier{})
	h.u.Arch = "arm64"
	rs.files[AssetName("v1.2.3", "arm64")] = tarball(t, []byte("unlisted"))
	err := h.u.Apply(context.Background(), h.u.Tagged("v1.2.3"))
	if !errors.Is(err, ErrChecksum) {
		t.Fatalf("err = %v, want ErrChecksum", err)
	}
	h.assertUnchanged(t)
}

func TestApplySignatureFailure(t *testing.T) {
	rs := newReleaseServer(t, "v1.2.3", []byte("new binary"))
	h := newHarness(t, rs, fakeVerifier{err: fmt.Errorf("bad bundle")})
	err := h.u.Apply(context.Background(), h.u.Tagged("v1.2.3"))
	if !errors.Is(err, ErrSignature) {
		t.Fatalf("err = %v, want ErrSignature", err)
	}
	h.assertUnchanged(t)
}

func TestApplyDowngrade(t *testing.T) {
	rs := newReleaseServer(t, "v0.9.0", []byte("older binary"))
	h := newHarness(t, rs, fakeVerifier{})
	err := h.u.Apply(context.Background(), h.u.Tagged("v0.9.0"))
	if !errors.Is(err, ErrDowngrade) {
		t.Fatalf("err = %v, want ErrDowngrade", err)
	}
	h.assertUnchanged(t)

	h.u.AllowDowngrade = true
	if err := h.u.Apply(context.Background(), h.u.Tagged("v0.9.0")); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(h.bin); string(got) != "older binary" {
		t.Fatalf("binary = %q", got)
	}
}

func TestFetchTrustedRoot(t *testing.T) {
	rs := newReleaseServer(t, "v1.2.3", []byte("new binary"))
	h := newHarness(t, rs, fakeVerifier{})
	got, err := h.u.FetchTrustedRoot(context.Background(), h.u.Tagged("v1.2.3"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `{"root":"new"}` {
		t.Fatalf("root = %q", got)
	}

	rs.files[TrustedRootName] = []byte(`{"root":"evil"}`)
	if _, err := h.u.FetchTrustedRoot(context.Background(), h.u.Tagged("v1.2.3")); !errors.Is(err, ErrChecksum) {
		t.Fatalf("tampered root: err = %v, want ErrChecksum", err)
	}
}
