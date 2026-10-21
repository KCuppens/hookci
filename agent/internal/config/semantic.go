package config

import (
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"regexp/syntax"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

// checkSemantics runs the rules the schema cannot express. It only runs on
// a file that passed the schema, so every value has the right shape.
//
// forks has no rule here: the schema limits it to gated or never, and never
// is enforced by the hub, which concludes fork checks action_required (M1).
func checkSemantics(cfg *HookCIConfig, opts ParseOptions, li lineIndex) Diagnostics {
	var diags Diagnostics
	if c := cfg.Checks; c != nil {
		diags = append(diags, checkReservedJobNames(c.Jobs, li)...)
		diags = append(diags, checkNeeds(c.Jobs, li)...)
		diags = append(diags, checkCommands(c, li)...)
		diags = append(diags, checkCachePaths(c.Setup, li)...)
		diags = append(diags, checkLimits(c, li)...)
	}
	diags = append(diags, checkTrust(cfg, opts, li)...)
	diags = append(diags, checkRedact(cfg.Redact, li)...)
	diags = append(diags, checkDeployments(cfg.Deployments, opts, li)...)
	return diags
}

// reservedJobNames are taken by the setup phase: its log is logs/setup.log,
// its unit hookci-run-<run>-setup, and `hookci logs <run> setup` shows it.
var reservedJobNames = []string{"setup"}

// checkReservedJobNames rejects jobs that would clash with the setup phase.
func checkReservedJobNames(jobs ChecksJobs, li lineIndex) Diagnostics {
	var diags Diagnostics
	for _, name := range reservedJobNames {
		if _, ok := jobs[name]; ok {
			diags = append(diags, li.errorf(joinKey("checks.jobs", name), "rename the job, for example "+quote(name+"-job"),
				"job name %s is reserved for the setup phase", quote(name)))
		}
	}
	return diags
}

// checkNeeds rejects needs that name an unknown job or the job itself, and
// reports every dependency cycle once.
func checkNeeds(jobs ChecksJobs, li lineIndex) Diagnostics {
	names := sortedKeys(jobs)
	var diags Diagnostics
	for _, name := range names {
		for i, need := range jobs[name].Needs {
			p := joinIndex("checks.jobs."+name+".needs", i)
			if need == name {
				diags = append(diags, li.errorf(p, "remove "+quote(name)+" from its own needs", "job %s cannot need itself", quote(name)))
			} else if _, ok := jobs[need]; !ok {
				diags = append(diags, li.errorf(p, "known jobs: "+strings.Join(names, ", "), "unknown job %s", quote(need)))
			}
		}
	}
	return append(diags, checkCycles(jobs, names, li)...)
}

// checkCycles walks the needs graph depth first; every back edge closes one
// cycle, reported starting from its alphabetically first job.
func checkCycles(jobs ChecksJobs, names []string, li lineIndex) Diagnostics {
	const (
		unvisited = iota
		onStack
		done
	)
	state := make(map[string]int, len(jobs))
	var stack []string
	var diags Diagnostics
	var visit func(name string)
	visit = func(name string) {
		state[name] = onStack
		stack = append(stack, name)
		for _, need := range jobs[name].Needs {
			if _, ok := jobs[need]; !ok || need == name {
				continue
			}
			switch state[need] {
			case unvisited:
				visit(need)
			case onStack:
				i := len(stack) - 1
				for stack[i] != need {
					i--
				}
				diags = append(diags, cycleDiagnostic(jobs, stack[i:], li))
			}
		}
		stack = stack[:len(stack)-1]
		state[name] = done
	}
	for _, name := range names {
		if state[name] == unvisited {
			visit(name)
		}
	}
	return diags
}

// cycleDiagnostic reports cycle, where each job needs the next and the last
// needs the first.
func cycleDiagnostic(jobs ChecksJobs, cycle []string, li lineIndex) Diagnostic {
	start := 0
	for i, name := range cycle {
		if name < cycle[start] {
			start = i
		}
	}
	ordered := append(append([]string(nil), cycle[start:]...), cycle[:start]...)
	first, next := ordered[0], ordered[1%len(ordered)]
	p := "checks.jobs." + first + ".needs"
	for i, need := range jobs[first].Needs {
		if need == next {
			p = joinIndex(p, i)
			break
		}
	}
	return li.errorf(p, "remove one of these needs so the jobs can run in order",
		"cycle: %s -> %s", strings.Join(ordered, " -> "), first)
}

// checkCommands rejects setup steps and jobs whose run is only whitespace.
func checkCommands(c *Checks, li lineIndex) Diagnostics {
	var diags Diagnostics
	for i, step := range c.Setup {
		if strings.TrimSpace(step.Run) == "" {
			diags = append(diags, li.errorf(joinIndex("checks.setup", i)+".run", "give the command to run", "run must not be blank"))
		}
	}
	for _, name := range sortedKeys(c.Jobs) {
		if strings.TrimSpace(c.Jobs[name].Run) == "" {
			diags = append(diags, li.errorf("checks.jobs."+name+".run", "give the command to run", "run must not be blank"))
		}
	}
	return diags
}

// checkCachePaths keeps cache paths inside the repository checkout.
func checkCachePaths(setup []SetupStep, li lineIndex) Diagnostics {
	var diags Diagnostics
	for i, step := range setup {
		if step.Cache == nil {
			continue
		}
		for j, p := range step.Cache.Paths {
			clean := filepath.Clean(p)
			if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
				diags = append(diags, li.errorf(joinIndex(joinIndex("checks.setup", i)+".cache.paths", j),
					"use a path inside the repository, for example node_modules",
					"cache path %s must be relative to the repository root and stay inside it", quote(p)))
			}
		}
	}
	return diags
}

// checkLimits rejects memory sizes and durations that match the schema
// pattern but are not usable, such as 0G or 0s.
func checkLimits(c *Checks, li lineIndex) Diagnostics {
	var diags Diagnostics
	limits := func(base string, l *Limits) {
		if l == nil {
			return
		}
		if _, err := ParseMemory(l.Memory); err != nil {
			diags = append(diags, li.errorf(base+".memory", "use a size such as 4G or 512M", "%v", err))
		}
		if _, err := ParseDuration(l.Timeout); err != nil {
			diags = append(diags, li.errorf(base+".timeout", "use a duration such as 90s, 10m or 1h", "%v", err))
		}
	}
	limits("checks.limits", c.Limits)
	for _, name := range sortedKeys(c.Jobs) {
		job := c.Jobs[name]
		limits("checks.jobs."+name+".limits", job.Limits)
		if job.Timeout != nil {
			if _, err := ParseDuration(*job.Timeout); err != nil {
				diags = append(diags, li.errorf("checks.jobs."+name+".timeout", "use a duration such as 90s, 10m or 1h", "%v", err))
			}
		}
	}
	return diags
}

// checkTrust refuses trust: all except on a self-hosted hub with no
// deployments, where only the operator's own runner is at stake.
func checkTrust(cfg *HookCIConfig, opts ParseOptions, li lineIndex) Diagnostics {
	if cfg.Checks == nil || cfg.Checks.Trust != ChecksTrustAll {
		return nil
	}
	if opts.SelfHosted && len(cfg.Deployments) == 0 {
		return nil
	}
	return Diagnostics{li.errorf("checks.trust", "use trust: approve, or self-host the hub without deployments",
		"trust: all is refused on the shared hub; it runs untrusted fork code with your runner's network")}
}

// checkRedact requires every redact pattern to compile as RE2.
func checkRedact(patterns []string, li lineIndex) Diagnostics {
	var diags Diagnostics
	for i, p := range patterns {
		if _, err := regexp.Compile(p); err != nil {
			msg := err.Error()
			var se *syntax.Error
			if errors.As(err, &se) {
				msg = fmt.Sprintf("%s in %s", se.Code, quote(se.Expr))
			}
			diags = append(diags, li.errorf(joinIndex("redact", i),
				`patterns use RE2 syntax: no lookaround or backreferences, and literal ( [ { . * + ? need a \ before them`,
				"invalid pattern: %s", msg))
		}
	}
	return diags
}

// checkDeployments checks each deployment's trigger, env_file and health
// URL.
func checkDeployments(deps HookCIConfigDeployments, opts ParseOptions, li lineIndex) Diagnostics {
	var diags Diagnostics
	for _, env := range sortedKeys(deps) {
		d := deps[env]
		base := "deployments." + env
		if d.On == nil || d.On.Push == nil || d.On.Push.Branch == nil || *d.On.Push.Branch == "" {
			diags = append(diags, li.errorf(base+".on.push.branch", "add on: {push: {branch: main}}",
				"a deployment must name the branch it deploys from"))
		}
		if d.EnvFile != nil {
			diags = append(diags, checkEnvFile(*d.EnvFile, base+".env_file", opts, li)...)
		}
		if d.Health != nil {
			if d.Health.Url != nil {
				diags = append(diags, checkHealthURL(*d.Health.Url, d.Strategy, base+".health.url", li)...)
			}
			if d.Health.Timeout != nil {
				if _, err := ParseDuration(*d.Health.Timeout); err != nil {
					diags = append(diags, li.errorf(base+".health.timeout", "use a duration such as 90s, 10m or 1h", "%v", err))
				}
			}
		}
	}
	return diags
}

// checkEnvFile warns when the env_file is missing, not owned by root, or
// writable by group or others. The schema already requires an absolute path.
func checkEnvFile(file, p string, opts ParseOptions, li lineIndex) Diagnostics {
	stat := opts.Stat
	if stat == nil {
		fsys := opts.FS
		if fsys == nil {
			fsys = os.DirFS("/").(fs.StatFS)
		}
		stat = func(name string) (fs.FileInfo, error) {
			rel := strings.TrimPrefix(path.Clean(name), "/")
			if rel == "" {
				rel = "."
			}
			return fsys.Stat(rel)
		}
	}
	fi, err := stat(file)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return Diagnostics{li.warnf(p, "create it on the deploy host, owned by root with mode 0600",
			"env_file %s does not exist on this machine", quote(file))}
	case err != nil:
		return Diagnostics{li.warnf(p, "", "cannot check env_file %s: %v", quote(file), err)}
	}
	var diags Diagnostics
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && st.Uid != 0 {
		diags = append(diags, li.warnf(p, "chown root:root "+file,
			"env_file %s is owned by uid %d, not root", quote(file), st.Uid))
	}
	if perm := fi.Mode().Perm(); perm&0o022 != 0 {
		diags = append(diags, li.warnf(p, "chmod go-w "+file,
			"env_file %s is writable by group or others (mode %04o)", quote(file), perm))
	}
	return diags
}

// checkHealthURL requires a plain-http URL on 127.0.0.1 or localhost with an
// explicit port. The {port} placeholder may stand for the port only with
// strategy: compose-bluegreen, which fills it in per color.
func checkHealthURL(raw string, strategy *DeploymentStrategy, p string, li lineIndex) Diagnostics {
	const example = "for example http://127.0.0.1:8000/health"
	placeholder := strings.Contains(raw, "{port}")
	u, err := url.Parse(strings.ReplaceAll(raw, "{port}", "1"))
	if err != nil || u.Host == "" {
		return Diagnostics{li.errorf(p, "use a full URL, "+example, "health.url %s is not a valid URL", quote(raw))}
	}
	var diags Diagnostics
	if u.Scheme != "http" {
		diags = append(diags, li.errorf(p, "use http, "+example,
			"health.url must use http, got %s", quote(u.Scheme)))
	}
	if host := u.Hostname(); host != "127.0.0.1" && host != "localhost" {
		diags = append(diags, li.errorf(p, "the check runs on the deploy host; point it at the local port, "+example,
			"health.url must point at 127.0.0.1 or localhost, got %s", quote(host)))
	}
	port := u.Port()
	switch {
	case port == "":
		diags = append(diags, li.errorf(p, "add the port, "+example, "health.url needs an explicit port"))
	case placeholder:
		if strings.Count(raw, "{port}") != 1 || !strings.Contains(raw, ":{port}") || port != "1" {
			diags = append(diags, li.errorf(p, "use {port} only as the port, for example http://127.0.0.1:{port}/health",
				"{port} may only stand for the port"))
		} else if strategy == nil || *strategy != DeploymentStrategyComposeBluegreen {
			diags = append(diags, li.errorf(p, "set strategy: compose-bluegreen, or use a fixed port",
				"{port} is only filled in by strategy: compose-bluegreen"))
		}
	default:
		if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
			diags = append(diags, li.errorf(p, "use a port between 1 and 65535", "port %s is out of range 1 to 65535", quote(port)))
		}
	}
	return diags
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
