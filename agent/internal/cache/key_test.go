package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
)

func writeFile(t *testing.T, path, content string, perm os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), perm); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, perm); err != nil {
		t.Fatal(err)
	}
}

func TestComputeKeyStable(t *testing.T) {
	wd := t.TempDir()
	writeFile(t, filepath.Join(wd, "package-lock.json"), "lock v1", 0o644)
	a, err := ComputeKey("trusted:kcuppens/app", "main", "linux-amd64", wd,
		[]string{"package-lock.json", "yarn.lock"}, []string{"node_modules", "web/.turbo"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := ComputeKey("trusted:kcuppens/app", "main", "linux-amd64", wd,
		[]string{"./yarn.lock", "package-lock.json"}, []string{"web/.turbo/", "./node_modules"})
	if err != nil {
		t.Fatal(err)
	}
	if a.Hash == "" || a.Hash != b.Hash {
		t.Fatalf("hash not stable: %q vs %q", a.Hash, b.Hash)
	}
	sum := sha256.Sum256([]byte("lock v1"))
	wantFiles := []string{"package-lock.json:" + hex.EncodeToString(sum[:]), "yarn.lock:missing"}
	if !slices.Equal(a.FileHashes, wantFiles) {
		t.Errorf("FileHashes = %v, want %v", a.FileHashes, wantFiles)
	}
	if want := []string{"node_modules", "web/.turbo"}; !slices.Equal(b.Paths, want) {
		t.Errorf("Paths = %v, want %v", b.Paths, want)
	}
}

func TestComputeKeyChangesOnLockfile(t *testing.T) {
	wd := t.TempDir()
	lock := filepath.Join(wd, "package-lock.json")
	writeFile(t, lock, "lock v1", 0o644)
	compute := func() Key {
		k, err := ComputeKey("trusted:kcuppens/app", "main", "linux-amd64", wd, []string{"package-lock.json"}, []string{"node_modules"})
		if err != nil {
			t.Fatal(err)
		}
		return k
	}
	before := compute()
	writeFile(t, lock, "lock v2", 0o644)
	changed := compute()
	if before.Hash == changed.Hash {
		t.Fatal("hash did not change with the lockfile")
	}
	if err := os.Remove(lock); err != nil {
		t.Fatal(err)
	}
	if missing := compute(); missing.Hash == changed.Hash || missing.Hash == before.Hash {
		t.Fatal("hash did not change when the lockfile went missing")
	}
}

func TestComputeKeyTrustDomainScopeAndPlatform(t *testing.T) {
	wd := t.TempDir()
	writeFile(t, filepath.Join(wd, "go.sum"), "sum", 0o644)
	seen := map[string]string{}
	for _, c := range []struct{ domain, scope, platform string }{
		{"trusted:kcuppens/app", "main", "linux-amd64"},
		{"untrusted:kcuppens/app", "main", "linux-amd64"},
		{"trusted:kcuppens/other", "main", "linux-amd64"},
		{"trusted:kcuppens/app", "main", "linux-arm64"},
		{"trusted:kcuppens/app", "feature/x", "linux-amd64"},
		{"trusted:kcuppens/app", "", "linux-amd64"},
	} {
		k, err := ComputeKey(c.domain, c.scope, c.platform, wd, []string{"go.sum"}, []string{"vendor"})
		if err != nil {
			t.Fatal(err)
		}
		if k.TrustDomain != c.domain || k.Scope != c.scope || k.Platform != c.platform {
			t.Errorf("key fields = %q %q %q", k.TrustDomain, k.Scope, k.Platform)
		}
		if prev, dup := seen[k.Hash]; dup {
			t.Errorf("%v has the same hash as %s", c, prev)
		}
		seen[k.Hash] = c.domain + " " + c.scope + " " + c.platform
	}
	for _, bad := range []string{"", "local", "trusted", "trusted:", "other:kcuppens/app", "trusted:../app", "trusted:kcuppens/app/x"} {
		if _, err := ComputeKey(bad, "main", "linux-amd64", wd, nil, []string{"vendor"}); err == nil {
			t.Errorf("trust domain %q accepted", bad)
		}
	}
	if _, err := ComputeKey("trusted:kcuppens/app", "main", "", wd, nil, []string{"vendor"}); err == nil {
		t.Error("empty platform accepted")
	}
	onMain, err := ComputeKey("trusted:kcuppens/app", "main", "linux-amd64", wd, []string{"go.sum"}, []string{"vendor"})
	if err != nil {
		t.Fatal(err)
	}
	feature, err := ComputeKey("trusted:kcuppens/app", "feature/x", "linux-amd64", wd, []string{"go.sum"}, []string{"vendor"})
	if err != nil {
		t.Fatal(err)
	}
	if got := onMain.InScope("feature/x"); !reflect.DeepEqual(got, feature) {
		t.Errorf("InScope = %+v, want %+v", got, feature)
	}
}

func TestComputeKeyRejectsTraversal(t *testing.T) {
	wd := t.TempDir()
	for _, c := range []struct {
		name            string
		keyFiles, paths []string
	}{
		{"key file escapes", []string{"../etc/passwd"}, []string{"node_modules"}},
		{"absolute path", nil, []string{"/abs"}},
		{"path escapes", nil, []string{"node_modules/../../x"}},
		{"workdir itself", nil, []string{"."}},
		{"absolute key file", []string{"/etc/passwd"}, []string{"node_modules"}},
	} {
		if _, err := ComputeKey("trusted:kcuppens/app", "main", "linux-amd64", wd, c.keyFiles, c.paths); !errors.Is(err, ErrBadPath) {
			t.Errorf("%s: err = %v, want ErrBadPath", c.name, err)
		}
	}
}

func TestComputeKeyKeyFileSymlinkStaysInWorkdir(t *testing.T) {
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "secret"), "host secret", 0o644)
	wd := t.TempDir()
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(wd, "package-lock.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := ComputeKey("untrusted:kcuppens/app", "main", "linux-amd64", wd, []string{"package-lock.json"}, []string{"node_modules"}); err == nil {
		t.Fatal("key file symlinked out of the workdir was hashed")
	}
}

func TestEntryDirSanitizesTrustDomain(t *testing.T) {
	k, err := ComputeKey("trusted:KCuppens/App", "main", "linux-amd64", t.TempDir(), nil, []string{"node_modules"})
	if err != nil {
		t.Fatal(err)
	}
	rel, err := k.entryRel()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join("trusted__kcuppens__app", k.Hash); rel != want {
		t.Errorf("entry = %q, want %q", rel, want)
	}
	rescoped := k
	rescoped.Scope = "feature/x"
	if _, err := rescoped.entryRel(); err == nil {
		t.Error("key whose scope does not match its hash accepted")
	}
	k.Paths = append(k.Paths, "extra")
	if _, err := k.entryRel(); err == nil {
		t.Error("key with fields that do not match its hash accepted")
	}
}

// Fields are length-prefixed, so moving a separator between or across
// fields and lists never yields the same hash.
func TestKeySumFramesFields(t *testing.T) {
	base := Key{TrustDomain: "trusted:o/r", Platform: "linux-amd64"}
	with := func(files, paths []string) Key {
		k := base
		k.FileHashes, k.Paths = files, paths
		return k
	}
	for _, pair := range [][2]Key{
		{with(nil, []string{"a", "b"}), with(nil, []string{"a\nb"})},
		{with([]string{"x"}, nil), with(nil, []string{"x"})},
		{with([]string{"a"}, []string{"b"}), with([]string{"a", "b"}, nil)},
		{{TrustDomain: "trusted:o/r\nlinux", Platform: "amd64"}, {TrustDomain: "trusted:o/r", Platform: "linux\namd64"}},
		{{TrustDomain: "trusted:o/r", Scope: "main\nlinux", Platform: "amd64"}, {TrustDomain: "trusted:o/r", Scope: "main", Platform: "linux\namd64"}},
	} {
		if pair[0].sum() == pair[1].sum() {
			t.Errorf("%+v and %+v share a hash", pair[0], pair[1])
		}
	}
}
