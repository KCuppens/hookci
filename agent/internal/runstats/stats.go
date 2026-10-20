// Package runstats turns finished check and deploy runs into the numbers a
// pilot report needs: median and p90 durations and the runner dollars saved
// against a hosted CI baseline.
package runstats

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"slices"
	"strings"
	"time"
)

// Run kinds and the status that counts as a success.
const (
	KindCheck     = "check"
	KindDeploy    = "deploy"
	StatusSuccess = "success"
)

// RunRecord is one finished run as zeroci runs export writes it. Durations
// are the agent's recorded start to finish; hub queue time is not in them.
type RunRecord struct {
	RunID      string    `json:"run_id"`
	Repo       string    `json:"repo"`
	Kind       string    `json:"kind"` // check|deploy
	Env        string    `json:"env,omitempty"`
	SHA        string    `json:"sha"`
	Status     string    `json:"status"`
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at"`
	DurationMS int64     `json:"duration_ms"`
}

// ReadJSONL decodes the RunRecords of a zeroci runs export stream.
func ReadJSONL(r io.Reader) ([]RunRecord, error) {
	dec := json.NewDecoder(r)
	var out []RunRecord
	for {
		var rec RunRecord
		err := dec.Decode(&rec)
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return nil, fmt.Errorf("runstats: record %d: %w", len(out)+1, err)
		}
		out = append(out, rec)
	}
}

// Baseline is what one run cost on the hosted CI the agent replaces: the
// wall time of its check and deploy workflows and the price of one runner
// minute in USD.
type Baseline struct {
	CheckSeconds      float64 `json:"check_seconds"`
	DeploySeconds     float64 `json:"deploy_seconds"`
	PricePerMinuteUSD float64 `json:"price_per_minute_usd"`
}

// KindStats summarises the runs of one kind. Count is every finished run;
// MedianMS and P90MS cover the successful ones only.
type KindStats struct {
	Count          int     `json:"count"`
	Succeeded      int     `json:"succeeded"`
	MedianMS       int64   `json:"median_ms"`
	P90MS          int64   `json:"p90_ms"`
	SavedPerRunUSD float64 `json:"saved_per_run_usd"`
	SavedTotalUSD  float64 `json:"saved_total_usd"`
}

// Report is the result of Compute over the window [Since, Until].
// MonthlyProjectionUSD is nil, JSON null, for a window under one day.
type Report struct {
	Since                time.Time `json:"since"`
	Until                time.Time `json:"until"`
	Baseline             Baseline  `json:"baseline"`
	Check                KindStats `json:"check"`
	Deploy               KindStats `json:"deploy"`
	MonthlyProjectionUSD *float64  `json:"monthly_projection_usd"`
}

// Compute summarises the runs that finished within [since, until]. Runs of
// another kind or without a finish time are ignored. Each finished run saves
// one baseline run, billed per started minute; the monthly projection scales
// the total saved over the window to 30 days, and is left out for a window
// under one day, which would inflate it.
func Compute(runs []RunRecord, b Baseline, since, until time.Time) Report {
	rep := Report{Since: since, Until: until, Baseline: b}
	var checkMS, deployMS []int64
	for _, r := range runs {
		if r.FinishedAt.IsZero() || r.FinishedAt.Before(since) || r.FinishedAt.After(until) {
			continue
		}
		var (
			ks  *KindStats
			dur *[]int64
		)
		switch r.Kind {
		case KindCheck:
			ks, dur = &rep.Check, &checkMS
		case KindDeploy:
			ks, dur = &rep.Deploy, &deployMS
		default:
			continue
		}
		ks.Count++
		if r.Status == StatusSuccess {
			ks.Succeeded++
			*dur = append(*dur, r.DurationMS)
		}
	}
	finish := func(ks *KindStats, ms []int64, baselineSeconds float64) {
		ks.MedianMS = Median(ms)
		ks.P90MS = percentile(ms, 0.9)
		ks.SavedPerRunUSD = BilledMinutes(baselineSeconds) * b.PricePerMinuteUSD
		ks.SavedTotalUSD = ks.SavedPerRunUSD * float64(ks.Count)
	}
	finish(&rep.Check, checkMS, b.CheckSeconds)
	finish(&rep.Deploy, deployMS, b.DeploySeconds)
	if days := until.Sub(since).Hours() / 24; days >= 1 {
		projection := (rep.Check.SavedTotalUSD + rep.Deploy.SavedTotalUSD) / days * 30
		rep.MonthlyProjectionUSD = &projection
	}
	return rep
}

// BilledMinutes is the runner minutes a hosted run of seconds is billed
// for: every started minute counts.
func BilledMinutes(seconds float64) float64 {
	return math.Ceil(seconds / 60)
}

// Median returns the middle value of ms, the mean of the two middle values
// (rounded down) for an even count, and 0 for none. ms is not modified.
func Median(ms []int64) int64 {
	n := len(ms)
	if n == 0 {
		return 0
	}
	s := slices.Sorted(slices.Values(ms))
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

// percentile returns the nearest-rank p-th percentile of ms, 0 for none.
func percentile(ms []int64, p float64) int64 {
	if len(ms) == 0 {
		return 0
	}
	s := slices.Sorted(slices.Values(ms))
	return s[int(math.Ceil(p*float64(len(s))))-1]
}

// Markdown renders r as a Markdown section for a pilot report.
func (r Report) Markdown() string {
	var sb strings.Builder
	days := r.Until.Sub(r.Since).Hours() / 24
	sb.WriteString("## ZeroCI run stats\n\n")
	fmt.Fprintf(&sb, "Window: %s to %s (%.1f days).\n\n", r.Since.UTC().Format(time.RFC3339), r.Until.UTC().Format(time.RFC3339), days)
	fmt.Fprintf(&sb, "Baseline: check %s s, deploy %s s per run, billed per started minute at $%s per minute.\n\n",
		trimFloat(r.Baseline.CheckSeconds), trimFloat(r.Baseline.DeploySeconds), trimFloat(r.Baseline.PricePerMinuteUSD))
	sb.WriteString("| Kind | Runs | Succeeded | Success rate | Median | p90 | Baseline | Minutes saved | Saved per run | Saved total |\n")
	sb.WriteString("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n")
	row := func(kind string, ks KindStats, baselineSeconds float64) {
		median, p90 := "-", "-"
		if ks.Succeeded > 0 {
			median, p90 = seconds(ks.MedianMS), seconds(ks.P90MS)
		}
		fmt.Fprintf(&sb, "| %s | %d | %d | %s | %s | %s | %s s | %s | $%.4f | $%.2f |\n",
			kind, ks.Count, ks.Succeeded, rate(ks), median, p90,
			trimFloat(baselineSeconds), trimFloat(BilledMinutes(baselineSeconds)*float64(ks.Count)),
			ks.SavedPerRunUSD, ks.SavedTotalUSD)
	}
	row(KindCheck, r.Check, r.Baseline.CheckSeconds)
	row(KindDeploy, r.Deploy, r.Baseline.DeploySeconds)
	projection := "n/a (window under one day)"
	if r.MonthlyProjectionUSD != nil {
		projection = fmt.Sprintf("$%.2f (saved / window days x 30)", *r.MonthlyProjectionUSD)
	}
	fmt.Fprintf(&sb, "\nSaved in the window: $%.2f. Monthly projection: %s.\n\n",
		r.Check.SavedTotalUSD+r.Deploy.SavedTotalUSD, projection)
	sb.WriteString("Durations are the agent's recorded start to finish times; hub queue time is excluded. " +
		"Median and p90 count successful runs only; minutes and dollars saved count every finished run.\n")
	return sb.String()
}

func rate(ks KindStats) string {
	if ks.Count == 0 {
		return "-"
	}
	return fmt.Sprintf("%.1f%%", 100*float64(ks.Succeeded)/float64(ks.Count))
}

func seconds(ms int64) string {
	return fmt.Sprintf("%.1f s", float64(ms)/1000)
}

func trimFloat(v float64) string {
	return fmt.Sprintf("%g", v)
}
