package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/runstats"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

const deployRun = "01JNDQ9000CCCCCCCCCCCCCCCC"

// seedRunsStore is seedStore (a failed check run and a queued one) plus a
// successful deploy run that took 40 s.
func seedRunsStore(t *testing.T) Deps {
	t.Helper()
	d, db, _ := seedStore(t)
	if err := db.InsertDeployRun(context.Background(), store.DeployRun{
		RunID: deployRun, Repo: "local/app", Env: "production", SHA: "fedcba9876543210fedcba9876543210fedcba98",
		Ref: "refs/heads/main", Strategy: "compose-bluegreen", State: store.DeploySuccess,
		CreatedAt: statusBase.Add(2 * time.Minute), StartedAt: statusBase.Add(3 * time.Minute),
		FinishedAt: statusBase.Add(3*time.Minute + 40*time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	return d
}

func runsOf(d Deps, args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := cmdRuns(context.Background(), d, args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestRunsExportCmd(t *testing.T) {
	d := seedRunsStore(t)
	code, out, errOut := runsOf(d, "export", "--since", statusBase.Format(time.RFC3339))
	if code != ExitOK {
		t.Fatalf("exit = %d, stderr %q", code, errOut)
	}
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("export wrote %d lines, want the finished check and deploy:\n%s", len(lines), out)
	}
	var recs []runstats.RunRecord
	for i, line := range lines {
		var r runstats.RunRecord
		dec := json.NewDecoder(strings.NewReader(line))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&r); err != nil {
			t.Fatalf("line %d is not a run record: %v\n%s", i+1, err, line)
		}
		recs = append(recs, r)
	}
	check, deploy := recs[0], recs[1]
	if check.RunID != failedRun || check.Kind != "check" || check.Status != "failed" || check.Repo != "local/app" ||
		!check.StartedAt.Equal(statusBase.Add(time.Second)) || check.DurationMS != 3500 {
		t.Errorf("check record = %+v", check)
	}
	if deploy.RunID != deployRun || deploy.Kind != "deploy" || deploy.Env != "production" || deploy.Status != "success" ||
		deploy.DurationMS != 40_000 {
		t.Errorf("deploy record = %+v", deploy)
	}
	if strings.Contains(lines[0], `"env"`) {
		t.Errorf("check record has an env: %s", lines[0])
	}

	code, out, _ = runsOf(d, "export", "--since", statusBase.Format(time.RFC3339), "--kind", "deploy", "--format", "jsonl")
	if code != ExitOK || strings.Count(out, "\n") != 1 || !strings.Contains(out, deployRun) {
		t.Errorf("--kind deploy: exit %d, out %q", code, out)
	}
	code, out, _ = runsOf(d, "export", "--since", statusBase.Add(time.Hour).Format(time.RFC3339), "--until", statusBase.Add(2*time.Hour).Format(time.RFC3339))
	if code != ExitOK || out != "" {
		t.Errorf("window after every run: exit %d, out %q", code, out)
	}
	code, _, _ = runsOf(Deps{Globals: Globals{StateDir: t.TempDir()}, Clock: d.Clock}, "export", "--since", statusBase.Format(time.RFC3339))
	if code != ExitOK {
		t.Errorf("state dir without a database: exit %d, want 0", code)
	}

	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"export"}, "--since is required"},
		{[]string{"export", "--since", "yesterday"}, "--since"},
		{[]string{"export", "--since", statusBase.Format(time.RFC3339), "--kind", "build"}, "--kind must be check or deploy"},
		{[]string{"export", "--since", statusBase.Format(time.RFC3339), "--format", "csv"}, "--format must be jsonl"},
		{[]string{"tally"}, `unknown command "tally"`},
	} {
		code, _, errOut := runsOf(d, c.args...)
		if code != ExitUsage || !strings.Contains(errOut, c.want) {
			t.Errorf("runs %v: exit %d, stderr %q; want %d and %q", c.args, code, errOut, ExitUsage, c.want)
		}
	}
}

func TestRunsStatsCmd(t *testing.T) {
	d := seedRunsStore(t)
	code, out, errOut := runsOf(d, "stats", "--since", statusBase.Format(time.RFC3339), "--baseline-check", "512", "--baseline-deploy", "530")
	if code != ExitUsage || out != "" || !strings.Contains(errOut, "--price-per-minute is required") {
		t.Errorf("missing --price-per-minute: exit %d, stdout %q, stderr %q", code, out, errOut)
	}
	code, _, errOut = runsOf(d, "stats", "--since", statusBase.Format(time.RFC3339), "--price-per-minute", "0.008")
	if code != ExitUsage || !strings.Contains(errOut, "--baseline-check and --baseline-deploy are required") {
		t.Errorf("missing baselines: exit %d, stderr %q", code, errOut)
	}
	code, _, errOut = runsOf(d, "stats", "--baseline-check", "512", "--baseline-deploy", "530", "--price-per-minute", "0.008")
	if code != ExitUsage || !strings.Contains(errOut, "--input FILE.jsonl or --since") {
		t.Errorf("no source: exit %d, stderr %q", code, errOut)
	}

	baseline := []string{"--baseline-check", "512", "--baseline-deploy", "530", "--price-per-minute", "0.008"}
	code, out, errOut = runsOf(d, append([]string{"stats", "--since", statusBase.Format(time.RFC3339)}, baseline...)...)
	if code != ExitOK {
		t.Fatalf("stats from the database: exit %d, stderr %q", code, errOut)
	}
	var rep runstats.Report
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatalf("stats JSON: %v\n%s", err, out)
	}
	if rep.Check.Count != 1 || rep.Check.Succeeded != 0 || rep.Deploy.Count != 1 || rep.Deploy.MedianMS != 40_000 ||
		rep.Check.SavedTotalUSD+rep.Deploy.SavedTotalUSD < 0.143 || rep.Check.SavedTotalUSD+rep.Deploy.SavedTotalUSD > 0.145 {
		t.Errorf("report = %+v", rep)
	}

	// The pilot flow: export, then stats --input on the file, as Markdown.
	_, exported, _ := runsOf(d, "export", "--since", statusBase.Format(time.RFC3339))
	path := filepath.Join(t.TempDir(), "runs.jsonl")
	if err := os.WriteFile(path, []byte(exported), 0o600); err != nil {
		t.Fatal(err)
	}
	code, out, errOut = runsOf(Deps{Clock: d.Clock}, append([]string{"stats", "--input", path, "--markdown"}, baseline...)...)
	if code != ExitOK {
		t.Fatalf("stats --input: exit %d, stderr %q", code, errOut)
	}
	for _, want := range []string{
		"Window: " + statusBase.Add(time.Second).Format(time.RFC3339) + " to " + statusBase.Add(3*time.Minute+40*time.Second).Format(time.RFC3339),
		"| check | 1 | 0 | 0.0% | - | - | 512 s | 9 | $0.0720 | $0.07 |",
		"| deploy | 1 | 1 | 100.0% | 40.0 s | 40.0 s | 530 s | 9 | $0.0720 | $0.07 |",
		"hub queue time is excluded",
		// The file spans minutes, too short to project to a month.
		"Monthly projection: n/a (window under one day).",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("markdown lacks %q:\n%s", want, out)
		}
	}
	code, out, errOut = runsOf(Deps{Clock: d.Clock}, append([]string{"stats", "--input", path}, baseline...)...)
	if code != ExitOK || !strings.Contains(out, `"monthly_projection_usd": null`) {
		t.Errorf("stats --input JSON: exit %d, stderr %q, want a null monthly_projection_usd:\n%s", code, errOut, out)
	}
	code, _, errOut = runsOf(d, append([]string{"stats", "--input", path, "--repo", "local/app"}, baseline...)...)
	if code != ExitUsage || !strings.Contains(errOut, "--repo filters the agent database") {
		t.Errorf("--input with --repo: exit %d, stderr %q", code, errOut)
	}
}
