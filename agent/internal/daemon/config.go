package daemon

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/detect"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/source"
)

// ConfigFile is the checks configuration at the root of a checkout.
const ConfigFile = ".hookci.yml"

// ConfigJob is the pseudo job that reports whether a pull request's own
// .hookci.yml is valid.
const ConfigJob = "_config"

// plan is what a checkout's configuration resolves to.
type plan struct {
	// checks are the jobs to run; nil when nothing is configured or detected.
	checks *config.ResolvedChecks
	// invalid holds the diagnostics of a configuration that has errors.
	invalid config.Diagnostics
	// head holds the diagnostics of a pull request's changed .hookci.yml;
	// nil when the pull request leaves the file alone.
	head *config.Diagnostics
	// slack is the trusted configuration's notify.slack block for the hub;
	// nil when it has none.
	slack *protocol.JobPlannedSlack
	// policy is what the trusted .hookci.yml declares about forks, before
	// the semantic checks judge it; nil when there is no file or it fails
	// the schema.
	policy *config.Policy
}

// resolvePlan picks the checks of co. A pull request (BaseDir set) runs the
// base branch's configuration, so a head commit cannot change what runs on
// the agent or where Slack hears of it; its own .hookci.yml, when it
// differs, is only validated. A base without a .hookci.yml falls back to
// detection on the head tree, as does a push without one.
func resolvePlan(co source.Checkout, opts config.ParseOptions) (plan, error) {
	trusted := co.Dir
	if co.BaseDir != "" {
		trusted = co.BaseDir
	}
	trustedData, err := readConfig(trusted)
	if err != nil {
		return plan{}, err
	}
	var p plan
	var cfg *config.Config
	if trustedData != nil {
		var diags config.Diagnostics
		cfg, diags = config.Parse(trustedData, opts)
		if diags.HasErrors() {
			p.invalid = diags
		}
		if policy, ok := config.DeclaredPolicy(trustedData); ok {
			p.policy = &policy
		}
	} else {
		det, err := detect.DetectDir(co.Dir)
		switch {
		case err == nil:
			cfg = det.Config
		case !errors.Is(err, detect.ErrNothingDetected):
			return plan{}, fmt.Errorf("daemon: detect checks: %w", err)
		}
	}
	if cfg != nil {
		if checks := cfg.Checks(); checks != nil && len(checks.Jobs) > 0 {
			p.checks = checks
		}
		p.slack = slackOverride(cfg)
	}

	if co.BaseDir == "" {
		return p, nil
	}
	headData, err := readConfig(co.Dir)
	if err != nil {
		return plan{}, err
	}
	if headData != nil && !bytes.Equal(headData, trustedData) {
		_, diags := config.Parse(headData, opts)
		p.head = &diags
	}
	return p, nil
}

// slackOverride is cfg's notify.slack block as the job_planned frame carries
// it, or nil when cfg has none.
func slackOverride(cfg *config.Config) *protocol.JobPlannedSlack {
	if cfg.Notify == nil || cfg.Notify.Slack == nil {
		return nil
	}
	s := cfg.Notify.Slack
	out := &protocol.JobPlannedSlack{Channel: s.Channel}
	if s.Notify != nil {
		n := protocol.JobPlannedSlackNotify(*s.Notify)
		out.Notify = &n
	}
	if s.Alert != nil {
		a := protocol.JobPlannedSlackAlert(*s.Alert)
		out.Alert = &a
	}
	return out
}

// readConfig returns dir's .hookci.yml, or nil when it has none.
func readConfig(dir string) ([]byte, error) {
	data, err := os.ReadFile(filepath.Join(dir, ConfigFile))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("daemon: read %s: %w", ConfigFile, err)
	}
	return data, nil
}

// annotations turns diagnostics into .hookci.yml annotations.
func annotations(diags config.Diagnostics) []protocol.AnnotationsItemsElem {
	items := make([]protocol.AnnotationsItemsElem, 0, len(diags))
	for _, d := range diags {
		level := protocol.AnnotationsItemsElemLevelFailure
		if d.Severity == config.SeverityWarning {
			level = protocol.AnnotationsItemsElemLevelWarning
		}
		msg := d.Message
		if d.Path != "" {
			msg = d.Path + ": " + msg
		}
		if d.Fix != "" {
			msg += "\nfix: " + d.Fix
		}
		items = append(items, protocol.AnnotationsItemsElem{
			Level:   level,
			Line:    max(1, d.Line),
			Message: msg,
			Path:    ConfigFile,
		})
	}
	return items
}

// configSummary is the reason of the _config event.
func configSummary(diags config.Diagnostics) (protocol.EventState, string) {
	errs := 0
	for _, d := range diags {
		if d.Severity == config.SeverityError {
			errs++
		}
	}
	switch errs {
	case 0:
		return protocol.EventStateSuccess, ConfigFile + " is valid; it applies once merged"
	case 1:
		return protocol.EventStateFailed, ConfigFile + " has 1 error"
	default:
		return protocol.EventStateFailed, fmt.Sprintf("%s has %d errors", ConfigFile, errs)
	}
}
