package store

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func TestRepoConfigsLatestRunWins(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "agent.db")
	now := t0
	s, err := Open(path, WithClock(func() time.Time { return now }))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	for _, c := range []RepoConfig{
		{Repo: "acme/web", SHA: "sha1", Trust: "all", HasDeployments: true},
		{Repo: "acme/api", SHA: "sha2", Trust: "collaborators"},
	} {
		if err := s.SaveRepoConfig(ctx, c.Repo, c.SHA, c.Trust, c.HasDeployments); err != nil {
			t.Fatal(err)
		}
	}
	now = t0.Add(time.Hour)
	if err := s.SaveRepoConfig(ctx, "acme/web", "sha3", "all", false); err != nil {
		t.Fatal(err)
	}

	got, err := ReadRepoConfigs(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	want := []RepoConfig{
		{Repo: "acme/api", SHA: "sha2", Trust: "collaborators", SeenAt: t0},
		{Repo: "acme/web", SHA: "sha3", Trust: "all", SeenAt: t0.Add(time.Hour)},
	}
	if !slices.Equal(got, want) {
		t.Errorf("ReadRepoConfigs = %+v, want %+v", got, want)
	}
}

func TestReadRepoConfigsLeavesOtherDatabasesAlone(t *testing.T) {
	ctx := context.Background()
	missing := filepath.Join(t.TempDir(), "agent.db")
	if got, err := ReadRepoConfigs(ctx, missing); err != nil || got != nil {
		t.Errorf("missing database: %+v, %v", got, err)
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Errorf("reading created the database: %v", err)
	}

	old := filepath.Join(t.TempDir(), "agent.db")
	db, err := sql.Open("sqlite", "file:"+old)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE runs (id TEXT PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	if got, err := ReadRepoConfigs(ctx, old); err != nil || got != nil {
		t.Errorf("database without the table: %+v, %v", got, err)
	}
}
