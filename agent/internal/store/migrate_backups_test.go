package store

import (
	"context"
	"slices"
	"testing"
	"time"
)

func TestMigrateBackupsStore(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	insert := func(repo, env, run, path string, at time.Time) {
		t.Helper()
		if err := s.InsertMigrateBackup(ctx, MigrateBackup{Repo: repo, Env: env, RunID: run, SHA: "sha-" + run, Path: path, CreatedAt: at}); err != nil {
			t.Fatal(err)
		}
	}
	insert("acme/web", "production", "r1", "/b/one.dump", t0)
	insert("acme/web", "production", "r3", "/b/three.dump", t0.Add(2*time.Hour))
	insert("acme/web", "production", "r2", "/b/two.dump", t0.Add(time.Hour))
	insert("acme/web", "production", "r2", "/b/two-b.dump", t0.Add(time.Hour))
	insert("acme/web", "staging", "r4", "/b/staging.dump", t0.Add(3*time.Hour))

	paths := func() []string {
		t.Helper()
		got, err := s.ListMigrateBackups(ctx, "acme/web", "production")
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, b := range got {
			out = append(out, b.Path)
		}
		return out
	}
	if got, want := paths(), []string{"/b/three.dump", "/b/two-b.dump", "/b/two.dump", "/b/one.dump"}; !slices.Equal(got, want) {
		t.Fatalf("list = %v, want newest first %v", got, want)
	}

	all, err := s.ListMigrateBackups(ctx, "acme/web", "production")
	if err != nil {
		t.Fatal(err)
	}
	first := all[0]
	if first.ID == 0 || first.Repo != "acme/web" || first.Env != "production" || first.RunID != "r3" ||
		first.SHA != "sha-r3" || !first.CreatedAt.Equal(t0.Add(2*time.Hour).Truncate(time.Millisecond)) {
		t.Fatalf("newest = %+v", first)
	}

	if err := s.DeleteMigrateBackup(ctx, all[3].ID); err != nil {
		t.Fatal(err)
	}
	if got, want := paths(), []string{"/b/three.dump", "/b/two-b.dump", "/b/two.dump"}; !slices.Equal(got, want) {
		t.Fatalf("after delete = %v, want %v", got, want)
	}
	staging, err := s.ListMigrateBackups(ctx, "acme/web", "staging")
	if err != nil || len(staging) != 1 {
		t.Fatalf("staging = %v, %v; want its one backup untouched", staging, err)
	}
}
