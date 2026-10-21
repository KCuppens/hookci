package runstats

import (
	"encoding/json"
	"math"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/testutil"
)

var (
	fixtureSince    = time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	fixtureUntil    = time.Date(2026, 3, 15, 0, 0, 0, 0, time.UTC)
	fixtureBaseline = Baseline{CheckSeconds: 512, DeploySeconds: 530, PricePerMinuteUSD: 0.008}
)

func TestMedian(t *testing.T) {
	for _, c := range []struct {
		name string
		in   []int64
		want int64
	}{
		{"empty", nil, 0},
		{"one", []int64{7}, 7},
		{"odd unsorted", []int64{300, 100, 200}, 200},
		{"even unsorted", []int64{40, 10, 30, 20}, 25},
		{"even rounds down", []int64{1, 2}, 1},
	} {
		in := append([]int64(nil), c.in...)
		if got := Median(c.in); got != c.want {
			t.Errorf("%s: Median(%v) = %d, want %d", c.name, c.in, got, c.want)
		}
		for i := range in {
			if in[i] != c.in[i] {
				t.Errorf("%s: Median reordered its input to %v", c.name, c.in)
				break
			}
		}
	}
}

func loadFixture(t *testing.T) []RunRecord {
	t.Helper()
	f, err := os.Open("testdata/runs.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	runs, err := ReadJSONL(f)
	if err != nil {
		t.Fatal(err)
	}
	return runs
}

func TestCompute_Fixture(t *testing.T) {
	runs := loadFixture(t)
	if len(runs) != 8 {
		t.Fatalf("fixture has %d runs, want 5 checks and 3 deploys", len(runs))
	}
	rep := Compute(runs, fixtureBaseline, fixtureSince, fixtureUntil)

	// 512 s and 530 s are both billed as 9 started minutes: 9 x $0.008.
	wantCheck := KindStats{Count: 5, Succeeded: 4, MedianMS: 95_000, P90MS: 120_000, SavedPerRunUSD: 0.072, SavedTotalUSD: 0.36}
	wantDeploy := KindStats{Count: 3, Succeeded: 2, MedianMS: 50_000, P90MS: 55_000, SavedPerRunUSD: 0.072, SavedTotalUSD: 0.216}
	checkStats(t, "check", rep.Check, wantCheck)
	checkStats(t, "deploy", rep.Deploy, wantDeploy)
	if want := 0.576 / 14 * 30; !nearPtr(rep.MonthlyProjectionUSD, want) {
		t.Errorf("MonthlyProjectionUSD = %v, want %v", rep.MonthlyProjectionUSD, want)
	}
	if !rep.Since.Equal(fixtureSince) || !rep.Until.Equal(fixtureUntil) || rep.Baseline != fixtureBaseline {
		t.Errorf("report window/baseline = %v %v %+v", rep.Since, rep.Until, rep.Baseline)
	}
}

func TestCompute_Window(t *testing.T) {
	runs := loadFixture(t)
	// Only the runs finished on 2026-03-05 and later: CHECK4, CHECK5,
	// DEPLOY2 (failed) and DEPLOY3.
	since := time.Date(2026, 3, 5, 0, 0, 0, 0, time.UTC)
	rep := Compute(runs, fixtureBaseline, since, fixtureUntil)
	checkStats(t, "check", rep.Check, KindStats{Count: 2, Succeeded: 2, MedianMS: 80_000, P90MS: 100_000, SavedPerRunUSD: 0.072, SavedTotalUSD: 0.144})
	checkStats(t, "deploy", rep.Deploy, KindStats{Count: 2, Succeeded: 1, MedianMS: 55_000, P90MS: 55_000, SavedPerRunUSD: 0.072, SavedTotalUSD: 0.144})
	if want := 0.288 / 10 * 30; !nearPtr(rep.MonthlyProjectionUSD, want) {
		t.Errorf("MonthlyProjectionUSD = %v, want %v", rep.MonthlyProjectionUSD, want)
	}

	empty := Compute(nil, fixtureBaseline, fixtureSince, fixtureSince)
	if empty.Check.Count != 0 || empty.MonthlyProjectionUSD != nil {
		t.Errorf("empty window report = %+v, want zero counts and no projection", empty)
	}
}

// A window of hours holding two runs would project them to a month as if
// they ran every few hours, so a window under one day gets no projection.
func TestCompute_NoProjectionUnderOneDay(t *testing.T) {
	runs := loadFixture(t)
	// CHECK4 and DEPLOY2 only.
	since := time.Date(2026, 3, 5, 12, 0, 0, 0, time.UTC)
	rep := Compute(runs, fixtureBaseline, since, since.Add(23*time.Hour))
	if rep.Check.Count != 1 || rep.Deploy.Count != 1 || rep.MonthlyProjectionUSD != nil {
		t.Fatalf("report = %+v, want 1 check, 1 deploy and no projection", rep)
	}
	if md := rep.Markdown(); !strings.Contains(md, "Monthly projection: n/a (window under one day).") {
		t.Errorf("markdown does not mark the projection n/a:\n%s", md)
	}
	out, err := json.Marshal(rep)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `"monthly_projection_usd":null`) {
		t.Errorf("JSON = %s, want a null monthly_projection_usd", out)
	}

	day := Compute(runs, fixtureBaseline, since, since.Add(24*time.Hour))
	if !nearPtr(day.MonthlyProjectionUSD, 0.144*30) {
		t.Errorf("one-day window MonthlyProjectionUSD = %v, want %v", day.MonthlyProjectionUSD, 0.144*30)
	}
}

func TestReportMarkdown(t *testing.T) {
	rep := Compute(loadFixture(t), fixtureBaseline, fixtureSince, fixtureUntil)
	md := rep.Markdown()
	if !strings.Contains(md, "hub queue time is excluded") {
		t.Errorf("markdown does not state that queue time is excluded:\n%s", md)
	}
	testutil.GoldenFile(t, "testdata/report.golden.md", []byte(md))
}

func checkStats(t *testing.T, kind string, got, want KindStats) {
	t.Helper()
	if got.Count != want.Count || got.Succeeded != want.Succeeded || got.MedianMS != want.MedianMS || got.P90MS != want.P90MS ||
		!near(got.SavedPerRunUSD, want.SavedPerRunUSD) || !near(got.SavedTotalUSD, want.SavedTotalUSD) {
		t.Errorf("%s stats = %+v, want %+v", kind, got, want)
	}
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func nearPtr(a *float64, b float64) bool { return a != nil && near(*a, b) }
