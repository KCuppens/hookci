package deploy

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// ChangeLister lists the files changed between two commits of a repository;
// truncated reports that the list is incomplete. trigger.GitHubRefChecker
// satisfies it.
type ChangeLister interface {
	ChangedFiles(ctx context.Context, repo, base, head string) (files []string, truncated bool, err error)
}

// MigrateBeforeDeps is what RunBeforeHook needs beyond the step context.
type MigrateBeforeDeps struct {
	Store   *store.Store
	Changes ChangeLister
	Now     func() time.Time
}

// defaultBackupRetain is the number of backups kept when migrate.before sets
// no retain.
const defaultBackupRetain = 10

// RunBeforeHook runs the migrate.before backup command of sc.Cfg when the
// push changes a file matching migrate.paths, records the files it wrote
// that the expanded command names, and deletes the recorded backups beyond
// retain. image is the image the command runs in unless migrate.before.image
// is set; network, when not empty, is the Docker network the container
// joins. The container gets each env_file key by name only: the deploy unit
// holds the values in its environment, and the docker CLI, running as the
// deploy user, cannot read the root-only file. It sets the outputs
// before_reason, before_ran and, after a run, backup_files.
func RunBeforeHook(ctx context.Context, sc *StepContext, deps MigrateBeforeDeps, image, network string) (bool, error) {
	run, migrate := sc.Run, sc.Cfg.Migrate
	before := migrate.Before

	var (
		prevSHA   string
		files     []string
		truncated bool
		listErr   error
	)
	state, ok, err := deps.Store.GetDeployState(ctx, run.Repo, run.Env)
	if err != nil {
		return false, fmt.Errorf("migrate.before: %w", err)
	}
	if ok {
		prevSHA = state.LastSuccessSHA
	}
	if prevSHA != "" && len(migrate.Paths) > 0 {
		if deps.Changes == nil {
			listErr = errors.New("no change lister")
		} else {
			files, truncated, listErr = deps.Changes.ChangedFiles(ctx, run.Repo, prevSHA, run.SHA)
		}
	}
	runHook, reason := shouldRunBefore(migrate.Paths, prevSHA, files, truncated, listErr)
	sc.Outputs["before_reason"] = reason
	if listErr != nil {
		fmt.Fprintf(sc.Log, "migrate.before: listing changes since %s: %v\n", shortSHA(prevSHA), listErr)
	}
	if !runHook {
		fmt.Fprintf(sc.Log, "migrate.before: skipped (%s)\n", reason)
		sc.Outputs["before_ran"] = "false"
		return false, nil
	}
	fmt.Fprintf(sc.Log, "migrate.before: running (%s)\n", reason)

	var dir string
	if before.OutputDir != nil {
		dir = *before.OutputDir
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return false, fmt.Errorf("migrate.before: %w", err)
	}
	if before.Image != nil {
		image = *before.Image
	}
	now := deps.Now().UTC()
	// Truncated so that a file system with second-granular mtimes still
	// counts a file written in the same second as new.
	start := now.Truncate(time.Second)

	argv := []string{"docker", "run", "--rm"}
	if network != "" {
		argv = append(argv, "--network", network)
	}
	if sc.Cfg.EnvFile != nil && *sc.Cfg.EnvFile != "" {
		env, err := LoadEnvFile(*sc.Cfg.EnvFile, true)
		if err != nil {
			return false, fmt.Errorf("deployments.%s.%w", run.Env, err)
		}
		for _, key := range slices.Sorted(maps.Keys(env)) {
			argv = append(argv, "-e", key)
		}
	}
	cmd := expandBackupTemplate(before.Run, run, now)
	argv = append(argv, "-v", dir+":/backup", image, "sh", "-c", cmd)
	if err := sc.Exec.Run(ctx, "migrate-before", argv, ExecOpts{Stdout: sc.Log, Stderr: sc.Log, Timeout: 30 * time.Minute}); err != nil {
		return false, err
	}

	written, others, err := newFiles(dir, start, cmd)
	if err != nil {
		return false, fmt.Errorf("migrate.before: %w", err)
	}
	for _, name := range others {
		fmt.Fprintf(sc.Log, "migrate.before: ignoring %s, not named in the command\n", name)
	}
	if len(written) == 0 {
		return false, fmt.Errorf("migrate.before produced no file in %s", dir)
	}
	for _, name := range written {
		if err := deps.Store.InsertMigrateBackup(ctx, store.MigrateBackup{
			Repo: run.Repo, Env: run.Env, RunID: run.RunID, SHA: run.SHA,
			Path: filepath.Join(dir, name), CreatedAt: now,
		}); err != nil {
			return false, fmt.Errorf("migrate.before: %w", err)
		}
	}
	sc.Outputs["before_ran"] = "true"
	sc.Outputs["backup_files"] = strings.Join(written, ",")

	retain := before.Retain
	if retain <= 0 {
		retain = defaultBackupRetain
	}
	pruneBackups(ctx, sc, deps.Store, dir, retain)
	return true, nil
}

// shouldRunBefore decides whether migrate.before runs. Without paths it
// always runs. With paths it runs on the first deploy, and when the change
// list since the last successful deploy is unavailable, truncated, or holds
// a file matching paths.
func shouldRunBefore(paths []string, prevSHA string, files []string, truncated bool, listErr error) (bool, string) {
	switch {
	case len(paths) == 0:
		return true, "no_paths"
	case prevSHA == "":
		return true, "first_deploy"
	case listErr != nil:
		return true, "diff_error"
	case truncated:
		return true, "diff_truncated"
	case MatchPaths(paths, files):
		return true, "paths_matched"
	default:
		return false, "no_migration_changes"
	}
}

// expandBackupTemplate replaces {env}, {sha7} and {ts} in cmd with the
// run's environment, its 7-character SHA and now in UTC as 20060102T150405Z.
func expandBackupTemplate(cmd string, run store.DeployRun, now time.Time) string {
	return strings.NewReplacer(
		"{env}", run.Env,
		"{sha7}", shortSHA(run.SHA),
		"{ts}", now.UTC().Format("20060102T150405Z"),
	).Replace(cmd)
}

// newFiles returns the names of the regular files in dir modified at or
// after start, sorted, split into those cmd names and the others. Another
// environment or a manual dump can write to a shared dir in the same window,
// so only a file the expanded command names is this run's backup. A name
// counts when it appears in cmd as a whole, not as part of a longer name.
func newFiles(dir string, start time.Time, cmd string) (named, others []string, err error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil, err
	}
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			return nil, nil, err
		}
		switch {
		case info.ModTime().Before(start):
		case namedIn(cmd, e.Name()):
			named = append(named, e.Name())
		default:
			others = append(others, e.Name())
		}
	}
	slices.Sort(named)
	slices.Sort(others)
	return named, others, nil
}

// namedIn reports whether name appears in cmd bounded on both sides by the
// ends of cmd or by a byte that cannot be part of a file name token.
func namedIn(cmd, name string) bool {
	for i := 0; ; {
		j := strings.Index(cmd[i:], name)
		if j < 0 {
			return false
		}
		j += i
		end := j + len(name)
		if (j == 0 || !nameByte(cmd[j-1])) && (end == len(cmd) || !nameByte(cmd[end])) {
			return true
		}
		i = j + 1
	}
}

func nameByte(c byte) bool {
	return c == '.' || c == '-' || c == '_' || '0' <= c && c <= '9' || 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z'
}

// pruneBackups deletes the recorded backups of the run's environment beyond
// the newest retain, file first, then its record. Only recorded files inside
// dir are deleted; a record of a file outside dir, left by an earlier
// output_dir, is forgotten and its file left in place. A failure is logged
// and leaves the record for the next run to retry; the backup just taken is
// already safe.
func pruneBackups(ctx context.Context, sc *StepContext, st *store.Store, dir string, retain int) {
	backups, err := st.ListMigrateBackups(ctx, sc.Run.Repo, sc.Run.Env)
	if err != nil {
		fmt.Fprintf(sc.Log, "migrate.before: retention: %v\n", err)
		return
	}
	for _, b := range backups[min(retain, len(backups)):] {
		rel, err := filepath.Rel(dir, b.Path)
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			if err := st.DeleteMigrateBackup(ctx, b.ID); err != nil {
				fmt.Fprintf(sc.Log, "migrate.before: retention: %v\n", err)
				continue
			}
			fmt.Fprintf(sc.Log, "migrate.before: retention: forgetting %s, outside %s; the file is kept\n", b.Path, dir)
			continue
		}
		if err := os.Remove(b.Path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			fmt.Fprintf(sc.Log, "migrate.before: retention: %v\n", err)
			continue
		}
		if err := st.DeleteMigrateBackup(ctx, b.ID); err != nil {
			fmt.Fprintf(sc.Log, "migrate.before: retention: %v\n", err)
			continue
		}
		fmt.Fprintf(sc.Log, "migrate.before: retention: deleted %s\n", filepath.Base(b.Path))
	}
}
