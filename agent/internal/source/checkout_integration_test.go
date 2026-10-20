//go:build integration

package source

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/isolation"
	"github.com/KCuppens/hookci/agent/internal/testutil"
)

// TestCheckoutAsJobUserIntegration checks out a local repo for the
// hookci-run account, as `hookci run --isolation systemd` does, and checks
// that the account owns every file of the tree and that the tree holds its
// own objects rather than borrowing the root-owned mirror's.
func TestCheckoutAsJobUserIntegration(t *testing.T) {
	testutil.RequireIntegration(t)
	testutil.EnsureUser(t, isolation.DefaultUser)
	cred, err := isolation.LookupCredential(isolation.DefaultUser)
	if err != nil {
		t.Fatal(err)
	}
	if cred.Uid == 0 {
		t.Fatalf("%s resolves to uid 0", isolation.DefaultUser)
	}

	repo := newRealRepo(t)
	head := plainGit(t, repo, "rev-parse", "HEAD")
	l, _ := newRealLocal(t, repo)
	dir := filepath.Join(t.TempDir(), "run", "src")
	co, err := l.Checkout(context.Background(), Request{RunAs: cred}, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer co.Release()

	if co.SHA != head {
		t.Fatalf("SHA = %s, want HEAD %s", co.SHA, head)
	}
	if got := plainGit(t, dir, "-c", "safe.directory="+dir, "rev-parse", "HEAD"); got != head {
		t.Fatalf("checkout HEAD = %s, want %s", got, head)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "app.txt")); err != nil || string(b) != "two\n" {
		t.Fatalf("app.txt = %q, %v; want committed HEAD content", b, err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".git", "objects", "info", "alternates")); !os.IsNotExist(err) {
		t.Fatalf("job user checkout borrows mirror objects: %v", err)
	}

	files := 0
	err = filepath.WalkDir(dir, func(p string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		fi, err := os.Lstat(p)
		if err != nil {
			return err
		}
		st := fi.Sys().(*syscall.Stat_t)
		if st.Uid != cred.Uid || st.Gid != cred.Gid {
			t.Errorf("%s owned by %d:%d, want %d:%d", p, st.Uid, st.Gid, cred.Uid, cred.Gid)
		}
		files++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if files < 3 {
		t.Fatalf("walked %d paths under %s, want the tree and its .git", files, dir)
	}
}
