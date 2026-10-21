package executor

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
)

func TestRunDirLayout(t *testing.T) {
	state := t.TempDir()
	d, err := NewRunDir(state, "01run", JobUser{})
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(state, "runs", "01run"); d.Root != want {
		t.Fatalf("Root = %s, want %s", d.Root, want)
	}
	for name, got := range map[string]string{"src": d.Src(), "home": d.Home(), "logs": d.Logs(), "tmp": d.Tmp(), "pg": d.PG()} {
		if want := filepath.Join(d.Root, name); got != want {
			t.Errorf("%s accessor = %s, want %s", name, got, want)
		}
		fi, err := os.Stat(got)
		if err != nil {
			t.Fatal(err)
		}
		if !fi.IsDir() || fi.Mode().Perm() != 0o700 {
			t.Errorf("%s: mode %v, want dir 0700", name, fi.Mode())
		}
	}
	if fi, err := os.Stat(d.Root); err != nil || fi.Mode().Perm() != 0o700 {
		t.Errorf("run dir: %v, %v; want mode 0700 without a job user", fi, err)
	}

	for _, bad := range []string{"", ".", "..", "a/b"} {
		if _, err := NewRunDir(state, bad, JobUser{}); err == nil {
			t.Errorf("NewRunDir(%q) succeeded", bad)
		}
	}
}

type chownCall struct {
	path     string
	uid, gid int
}

// recordChown returns a JobUser.Chown that records its calls instead of
// changing owners, which needs root.
func recordChown(calls *[]chownCall) func(string, int, int) error {
	return func(path string, uid, gid int) error {
		*calls = append(*calls, chownCall{path, uid, gid})
		return nil
	}
}

// selfCred is the test user's credential: every ancestor of a temp dir is
// searchable by it.
func selfCred() *syscall.Credential {
	return &syscall.Credential{Uid: uint32(os.Getuid()), Gid: uint32(os.Getgid())}
}

func TestRunDirJobUserOwnsWorkDirs(t *testing.T) {
	state := t.TempDir()
	cred := selfCred()
	var calls []chownCall
	d, err := NewRunDir(state, "01run", JobUser{Cred: cred, Chown: recordChown(&calls)})
	if err != nil {
		t.Fatal(err)
	}
	uid, gid := int(cred.Uid), int(cred.Gid)
	want := []chownCall{{d.Src(), uid, gid}, {d.Home(), uid, gid}, {d.Tmp(), uid, gid}}
	if !slices.Equal(calls, want) {
		t.Errorf("chown calls = %+v, want %+v", calls, want)
	}
	for path, mode := range map[string]os.FileMode{
		state:                        0o711,
		filepath.Join(state, "runs"): 0o711,
		d.Root:                       0o711,
		d.Src():                      0o700,
		d.Home():                     0o700,
		d.Tmp():                      0o700,
		d.Logs():                     0o700,
		d.PG():                       0o700,
	} {
		fi, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != mode {
			t.Errorf("%s: mode %o, want %o", path, fi.Mode().Perm(), mode)
		}
	}
}

func TestRunDirJobUserMustReachStateDir(t *testing.T) {
	// t.TempDir's parent is 0700 and the test user's, so another uid cannot
	// reach a state dir below it.
	state := filepath.Join(t.TempDir(), "state")
	var calls []chownCall
	other := &syscall.Credential{Uid: uint32(os.Getuid()) + 1, Gid: uint32(os.Getgid()) + 1}
	_, err := NewRunDir(state, "01run", JobUser{Cred: other, Chown: recordChown(&calls)})
	if err == nil || !strings.Contains(err.Error(), "not searchable") {
		t.Fatalf("err = %v, want a not searchable error", err)
	}
	if len(calls) != 0 {
		t.Errorf("chowned an unreachable run dir: %+v", calls)
	}
}
