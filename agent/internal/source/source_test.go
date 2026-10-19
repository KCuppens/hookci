package source

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestSlug(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"https://github.com/KCuppens/zerocideploy.git", "github.com_KCuppens_zerocideploy"},
		{"git@github.com:KCuppens/zerocideploy.git", "github.com_KCuppens_zerocideploy"},
		{"KCuppens/zerocideploy", "KCuppens_zerocideploy"},
		{"git://example.com/repo", "example.com_repo"},
		{"", "repo"},
	}

	for _, tt := range tests {
		got := Slug(tt.input)
		if got != tt.want {
			t.Errorf("Slug(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestAskPass(t *testing.T) {
	token := "ghp_secretToken12345"
	ap, err := NewAskPass(token)
	if err != nil {
		t.Fatalf("NewAskPass failed: %v", err)
	}
	defer ap.Cleanup()

	// Verify env
	env := ap.Env()
	if len(env) < 2 || !strings.HasPrefix(env[0], "GIT_ASKPASS=") {
		t.Fatalf("unexpected env: %v", env)
	}

	// Verify script execution outputs token
	out, err := exec.Command(ap.scriptPath).Output()
	if err != nil {
		t.Fatalf("execute askpass script failed: %v", err)
	}
	if strings.TrimSpace(string(out)) != token {
		t.Errorf("output = %q, want %q", strings.TrimSpace(string(out)), token)
	}

	// Verify cleanup
	dir := ap.tmpDir
	ap.Cleanup()
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("directory %s still exists after cleanup", dir)
	}
}

func initGitRepo(t *testing.T, dir string) string {
	t.Helper()
	run := func(args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s failed: %v\noutput: %s", strings.Join(args, " "), err, string(out))
		}
		return strings.TrimSpace(string(out))
	}

	run("init")
	run("config", "user.name", "Test")
	run("config", "user.email", "test@example.com")

	filePath := filepath.Join(dir, "README.md")
	if err := os.WriteFile(filePath, []byte("# Hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	run("add", "README.md")
	run("commit", "-m", "initial commit")
	return run("rev-parse", "HEAD")
}

func TestLocalSource(t *testing.T) {
	ctx := context.Background()

	t.Run("git repo shared clone", func(t *testing.T) {
		srcDir := t.TempDir()
		commit := initGitRepo(t, srcDir)

		targetDir := filepath.Join(t.TempDir(), "target")
		src := NewLocalSource(nil, srcDir, "")

		checkout, err := src.Prepare(ctx, targetDir)
		if err != nil {
			t.Fatalf("Prepare failed: %v", err)
		}
		if checkout.Commit != commit {
			t.Errorf("checkout.Commit = %q, want %q", checkout.Commit, commit)
		}

		readme, err := os.ReadFile(filepath.Join(targetDir, "README.md"))
		if err != nil {
			t.Fatalf("read README.md: %v", err)
		}
		if string(readme) != "# Hello\n" {
			t.Errorf("README content mismatch: %q", string(readme))
		}
	})

	t.Run("non-git directory copy", func(t *testing.T) {
		srcDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(srcDir, "file.txt"), []byte("non-git"), 0o644); err != nil {
			t.Fatal(err)
		}

		targetDir := filepath.Join(t.TempDir(), "target")
		src := NewLocalSource(nil, srcDir, "")

		checkout, err := src.Prepare(ctx, targetDir)
		if err != nil {
			t.Fatalf("Prepare failed: %v", err)
		}
		if checkout.Commit != "local" {
			t.Errorf("checkout.Commit = %q, want local", checkout.Commit)
		}

		content, err := os.ReadFile(filepath.Join(targetDir, "file.txt"))
		if err != nil {
			t.Fatalf("read file.txt: %v", err)
		}
		if string(content) != "non-git" {
			t.Errorf("content mismatch: %q", string(content))
		}
	})
}

func TestMirrorAndSharedClone(t *testing.T) {
	ctx := context.Background()
	srcDir := t.TempDir()
	commit := initGitRepo(t, srcDir)

	mirrorDir := filepath.Join(t.TempDir(), "mirror.git")
	mirror := NewMirror(nil, srcDir, mirrorDir, "")

	// Test Sync
	if err := mirror.Sync(ctx); err != nil {
		t.Fatalf("mirror.Sync failed: %v", err)
	}

	// Verify mirror is bare repo
	headPath := filepath.Join(mirrorDir, "HEAD")
	if _, err := os.Stat(headPath); os.IsNotExist(err) {
		t.Fatalf("mirror HEAD missing: %s", headPath)
	}

	// Test SharedClone
	targetDir := filepath.Join(t.TempDir(), "target")
	checkout, err := mirror.SharedClone(ctx, targetDir, "HEAD")
	if err != nil {
		t.Fatalf("SharedClone failed: %v", err)
	}
	if checkout.Commit != commit {
		t.Errorf("checkout commit = %s, want %s", checkout.Commit, commit)
	}

	// Verify alternates file exists (proving --shared)
	alternatesFile := filepath.Join(targetDir, ".git", "objects", "info", "alternates")
	altContent, err := os.ReadFile(alternatesFile)
	if err != nil {
		t.Fatalf("read alternates file failed: %v", err)
	}
	if !strings.Contains(string(altContent), mirrorDir) {
		t.Errorf("alternates does not point to mirror: %s", string(altContent))
	}
}
