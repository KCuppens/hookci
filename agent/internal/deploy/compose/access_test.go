package compose

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
)

const testDeployGID = 4242

type chownCall struct {
	name     string
	uid, gid int
}

// fakeChown records chown calls instead of changing owners.
type fakeChown struct {
	mu    sync.Mutex
	calls []chownCall
	err   error
}

func (f *fakeChown) chown(name string, uid, gid int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, chownCall{name, uid, gid})
	return f.err
}

func (f *fakeChown) recorded() []chownCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// access returns a UnitAccess for a deploy user with testDeployGID.
func (f *fakeChown) access() *UnitAccess {
	return &UnitAccess{
		Cred:  func() (*syscall.Credential, error) { return &syscall.Credential{Uid: 4243, Gid: testDeployGID}, nil },
		Chown: f.chown,
	}
}

// wantHandedOver checks that path is a 0640 file under stateDir with data,
// that every dir between stateDir and path is 0710, and that chown gave each
// of them, and the file before its rename, the deploy group and nothing else.
func wantHandedOver(t *testing.T, chown *fakeChown, stateDir, path string, data []byte) {
	t.Helper()
	rel, err := filepath.Rel(stateDir, path)
	if err != nil || strings.HasPrefix(rel, "..") {
		t.Fatalf("override %s is not under the state dir %s", path, stateDir)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading override: %v", err)
	}
	if data != nil && string(got) != string(data) {
		t.Errorf("override = %q, want %q", got, data)
	}
	wantMode(t, path, 0o640)
	var wantDirs []string
	for d := filepath.Dir(path); d != stateDir; d = filepath.Dir(d) {
		wantMode(t, d, 0o710|os.ModeDir)
		wantDirs = append(wantDirs, d)
	}
	slices.Reverse(wantDirs)
	calls := chown.recorded()
	var dirs []string
	file := 0
	for _, c := range calls {
		if c.uid != -1 || c.gid != testDeployGID {
			t.Errorf("chown(%s, %d, %d), want uid -1 and gid %d", c.name, c.uid, c.gid, testDeployGID)
		}
		switch {
		case strings.HasPrefix(c.name, filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".tmp-")):
			file++
		case slices.Contains(wantDirs, c.name):
			if !slices.Contains(dirs, c.name) {
				dirs = append(dirs, c.name)
			}
		default:
			if filepath.Dir(c.name) != filepath.Dir(path) || strings.Contains(c.name, "active-color") {
				t.Errorf("chown(%s): want only the override dirs and override files", c.name)
			}
		}
	}
	if !slices.Equal(dirs, wantDirs) {
		t.Errorf("chowned dirs %q, want %q", dirs, wantDirs)
	}
	if file == 0 {
		t.Errorf("the override %s was never chowned", path)
	}
}

func wantMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode() & (os.ModeDir | os.ModePerm); got != want {
		t.Errorf("mode of %s = %v, want %v", path, got, want)
	}
}

func TestWriteOverrideHandsOverToDeployGroup(t *testing.T) {
	stateDir := t.TempDir()
	path := filepath.Join(stateDir, "deploy", "acme", "web", "prod", "blue.override.yml")
	chown := &fakeChown{}
	data := []byte("services: {}\n")
	if err := chown.access().writeOverride(stateDir, path, data); err != nil {
		t.Fatalf("writeOverride: %v", err)
	}
	wantHandedOver(t, chown, stateDir, path, data)
	for _, c := range chown.recorded() {
		if c.name == stateDir {
			t.Errorf("the state dir itself was chowned")
		}
	}

	// A rewrite, as on resume, hands the new file over again.
	if err := chown.access().writeOverride(stateDir, path, []byte("services: {web: {}}\n")); err != nil {
		t.Fatalf("second writeOverride: %v", err)
	}
	wantHandedOver(t, chown, stateDir, path, []byte("services: {web: {}}\n"))
}

func TestWriteOverrideWithoutAccessStaysPrivate(t *testing.T) {
	stateDir := t.TempDir()
	path := filepath.Join(stateDir, "deploy", "acme", "web", "prod", "inplace.override.yml")
	var a *UnitAccess
	if err := a.writeOverride(stateDir, path, []byte("x")); err != nil {
		t.Fatalf("writeOverride: %v", err)
	}
	wantMode(t, path, 0o640)
	wantMode(t, filepath.Join(stateDir, "deploy"), 0o700|os.ModeDir)
}

func TestWriteOverrideRefusesPathOutsideStateDir(t *testing.T) {
	stateDir := t.TempDir()
	chown := &fakeChown{}
	path := filepath.Join(filepath.Dir(stateDir), "elsewhere", "blue.override.yml")
	err := chown.access().writeOverride(stateDir, path, []byte("x"))
	if err == nil || !strings.HasPrefix(err.Error(), "compose: ") {
		t.Fatalf("writeOverride outside the state dir: err = %v, want a compose error", err)
	}
	if len(chown.recorded()) != 0 {
		t.Errorf("chown calls %v for a refused path", chown.recorded())
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("override written outside the state dir: %v", err)
	}
}

func TestWriteOverrideChownFailureKeepsOldFile(t *testing.T) {
	stateDir := t.TempDir()
	path := filepath.Join(stateDir, "deploy", "acme", "web", "prod", "blue.override.yml")
	ok := &fakeChown{}
	if err := ok.access().writeOverride(stateDir, path, []byte("old")); err != nil {
		t.Fatalf("writeOverride: %v", err)
	}
	failing := &fakeChown{err: errors.New("operation not permitted")}
	err := failing.access().writeOverride(stateDir, path, []byte("new"))
	if err == nil || !strings.Contains(err.Error(), "operation not permitted") {
		t.Fatalf("writeOverride with a failing chown: err = %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "old" {
		t.Errorf("override = %q after a failed hand-over, want the old content", got)
	}
}
