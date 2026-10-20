package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"path"
	"slices"
	"strconv"
	"strings"
	"time"
)

// ValidationError is one problem in a configuration: the dotted path of the
// key, what is wrong with it, and how to fix it.
type ValidationError struct {
	Path string
	Msg  string
	Fix  string
}

// Error renders the problem as "<path>: <msg>; <fix>".
func (e ValidationError) Error() string {
	s := e.Path + ": " + e.Msg
	if e.Fix != "" {
		s += "; " + e.Fix
	}
	return s
}

const durationFix = "use a duration such as 90s, 10m or 1h"

// ParseDuration parses s with time.ParseDuration and requires it to be
// positive. A failure is a ValidationError for field.
func ParseDuration(field, s string) (time.Duration, error) {
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, ValidationError{Path: field, Msg: fmt.Sprintf("duration %s: want a number with a unit such as 500ms, 90s, 10m or 1h", quote(s)), Fix: durationFix}
	}
	if d <= 0 {
		return 0, ValidationError{Path: field, Msg: fmt.Sprintf("duration %s: must be greater than zero", quote(s)), Fix: durationFix}
	}
	return d, nil
}

// isCompose reports whether the strategy runs a Docker Compose service.
func isCompose(s DeploymentStrategy) bool {
	return s == DeploymentStrategyComposeBluegreen || s == DeploymentStrategyComposeInplace
}

// fillDeploymentDefaults gives each deployment without a verify or retain
// section one holding the schema defaults, as if the file had written {}.
func fillDeploymentDefaults(cfg *ZeroCIConfig) {
	for env, d := range cfg.Deployments {
		if d.Verify == nil {
			d.Verify = &DeploymentVerify{}
			_ = json.Unmarshal([]byte("{}"), d.Verify) // {} always decodes
		}
		if d.Retain == nil {
			d.Retain = &DeploymentRetain{}
			_ = json.Unmarshal([]byte("{}"), d.Retain)
		}
		cfg.Deployments[env] = d
	}
}

// ValidateDeployments checks the deployment rules the schema cannot express:
// the sections each strategy requires, the health URL, absolute host paths,
// durations, and needs between environments. cfg must have passed the
// schema. Every problem is returned, in environment name order.
func ValidateDeployments(cfg *ZeroCIConfig) []ValidationError {
	var errs []ValidationError
	names := sortedKeys(cfg.Deployments)
	for _, env := range names {
		errs = append(errs, validateDeployment(env, cfg.Deployments[env])...)
		errs = append(errs, validateNeeds(env, cfg.Deployments, names)...)
	}
	return append(errs, deploymentCycles(cfg.Deployments)...)
}

func validateDeployment(env string, d Deployment) []ValidationError {
	base := "deployments." + env
	strategy := string(d.Strategy)
	compose := isCompose(d.Strategy)
	var errs []ValidationError
	required := func(key, fix string) {
		errs = append(errs, ValidationError{Path: base + "." + key, Msg: "required by strategy: " + strategy, Fix: fix})
	}
	if compose && d.Compose == nil {
		required("compose", "add compose: {project: <project>, service: <service>}")
	}
	if d.Strategy == DeploymentStrategyComposeBluegreen && d.Route == nil {
		required("route", "add route: {kind: caddy, file: /etc/caddy/routes/"+env+".caddy}")
	}
	if compose && d.Health == nil {
		required("health", "add health: {url: \"http://127.0.0.1:{port}/health\"}")
	}
	if d.Strategy == DeploymentStrategyScript && d.Run == nil {
		required("run", "add run: <deploy command>")
	}
	if d.Rollback != nil && d.Strategy != DeploymentStrategyScript {
		errs = append(errs, ValidationError{Path: base + ".rollback", Msg: "only used by strategy: script; " + strategy + " rolls back by itself", Fix: "remove rollback"})
	}

	absolute := func(key string, value *string, example string) {
		if value != nil && !path.IsAbs(*value) {
			errs = append(errs, ValidationError{Path: base + "." + key,
				Msg: fmt.Sprintf("%s %s must be an absolute path", key, quote(*value)),
				Fix: "use a path that starts with /, for example " + example})
		}
	}
	absolute("env_file", d.EnvFile, "/etc/zeroci/"+env+".env")
	if d.Route != nil {
		absolute("route.file", &d.Route.File, "/etc/caddy/routes/"+env+".caddy")
	}
	if d.Compose != nil {
		absolute("compose.marker", d.Compose.Marker, "/var/lib/zeroci/"+env+".color")
		if slices.Contains(strings.Split(d.Compose.File, "/"), "..") {
			errs = append(errs, ValidationError{Path: base + ".compose.file",
				Msg: fmt.Sprintf("compose.file %s must not contain ..", quote(d.Compose.File)),
				Fix: "name a compose file inside the repository, for example compose.yml"})
		}
	}

	duration := func(key, value string) (time.Duration, bool) {
		v, err := ParseDuration(base+"."+key, value)
		if err != nil {
			errs = append(errs, err.(ValidationError))
			return 0, false
		}
		return v, true
	}
	if h := d.Health; h != nil {
		errs = append(errs, validateHealthURL(h.Url, compose, base+".health.url")...)
		duration("health.interval", h.Interval)
	}
	if v := d.Verify; v != nil {
		window, okWindow := duration("verify.window", v.Window)
		interval, okInterval := duration("verify.interval", v.Interval)
		if okWindow && okInterval && interval > window {
			errs = append(errs, ValidationError{Path: base + ".verify.interval",
				Msg: fmt.Sprintf("interval %s is longer than window %s", v.Interval, v.Window),
				Fix: "make verify.interval at most verify.window"})
		}
	}
	return errs
}

// validateHealthURL requires a plain-http URL on 127.0.0.1 or localhost with
// a port. The compose strategies fill in {port} per container, so their URL
// must use it as the port; script deployments need a fixed port.
func validateHealthURL(raw string, compose bool, p string) []ValidationError {
	const example = "for example http://127.0.0.1:8000/health"
	fail := func(fix, format string, args ...any) ValidationError {
		return ValidationError{Path: p, Msg: fmt.Sprintf(format, args...), Fix: fix}
	}
	placeholder := strings.Contains(raw, "{port}")
	if compose && !placeholder {
		return []ValidationError{fail("add {port} to the health URL", "must contain {port}")}
	}
	u, err := url.Parse(strings.ReplaceAll(raw, "{port}", "1"))
	if err != nil || u.Host == "" {
		return []ValidationError{fail("use a full URL, "+example, "health.url %s is not a valid URL", quote(raw))}
	}
	var errs []ValidationError
	if u.Scheme != "http" {
		errs = append(errs, fail("use http, "+example, "health.url must use http, got %s", quote(u.Scheme)))
	}
	if host := u.Hostname(); host != "127.0.0.1" && host != "localhost" {
		errs = append(errs, fail("the check runs on the deploy host; point it at the local port, "+example,
			"health.url must point at 127.0.0.1 or localhost, got %s", quote(host)))
	}
	port := u.Port()
	switch {
	case port == "":
		errs = append(errs, fail("add the port, "+example, "health.url needs an explicit port"))
	case placeholder:
		if strings.Count(raw, "{port}") != 1 || !strings.Contains(raw, ":{port}") || port != "1" {
			errs = append(errs, fail("use {port} only as the port, for example http://127.0.0.1:{port}/health",
				"{port} may only stand for the port"))
		} else if !compose {
			errs = append(errs, fail("use a fixed port, or a compose strategy",
				"{port} is only filled in by the compose strategies"))
		}
	default:
		if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
			errs = append(errs, fail("use a port between 1 and 65535", "port %s is out of range 1 to 65535", quote(port)))
		}
	}
	return errs
}

// validateNeeds rejects needs that name an unknown environment or the
// environment itself.
func validateNeeds(env string, deps ZeroCIConfigDeployments, names []string) []ValidationError {
	var errs []ValidationError
	for i, need := range deps[env].Needs {
		p := joinIndex("deployments."+env+".needs", i)
		if need == env {
			errs = append(errs, ValidationError{Path: p, Msg: fmt.Sprintf("environment %s cannot need itself", quote(env)), Fix: "remove " + quote(env) + " from its own needs"})
		} else if _, ok := deps[need]; !ok {
			errs = append(errs, ValidationError{Path: p, Msg: fmt.Sprintf("unknown environment %s", quote(need)), Fix: "known environments: " + strings.Join(names, ", ")})
		}
	}
	return errs
}

// deploymentCycles reports every cycle in the needs between environments
// once, on the needs of the environment whose need closes it: with
// production needing staging and staging needing production, staging is the
// one reported.
func deploymentCycles(deps ZeroCIConfigDeployments) []ValidationError {
	graph := make(map[string][]string, len(deps))
	for env, d := range deps {
		graph[env] = d.Needs
	}
	var errs []ValidationError
	for _, cycle := range needsCycles(graph) {
		errs = append(errs, ValidationError{Path: "deployments." + cycle[len(cycle)-1] + ".needs",
			Msg: fmt.Sprintf("cycle: %s -> %s", strings.Join(cycle, " -> "), cycle[0]),
			Fix: "remove one of these needs so the environments can deploy in order"})
	}
	return errs
}
