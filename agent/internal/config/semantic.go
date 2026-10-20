package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"regexp/syntax"
	"slices"
	"sort"
	"strings"
	"syscall"
)

// checkSemantics runs the rules the schema cannot express. It only runs on
// a file that passed the schema, so every value has the right shape.
//
// forks has no rule here: the schema limits it to gated or never, and never
// is enforced by the hub, which concludes fork checks action_required (M1).
func checkSemantics(cfg *ZeroCIConfig, opts ParseOptions, li lineIndex) Diagnostics {
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
	diags = append(diags, checkDeployments(cfg, opts, li)...)
	return diags
}

// reservedJobNames are taken by the setup phase: its log is logs/setup.log,
// its unit zeroci-run-<run>-setup, and `zeroci logs <run> setup` shows it.
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
	return append(diags, checkCycles(jobs, li)...)
}

// checkCycles reports every cycle in the needs between jobs once, on the
// need of its alphabetically first job that points at the next one.
func checkCycles(jobs ChecksJobs, li lineIndex) Diagnostics {
	graph := make(map[string][]string, len(jobs))
	for name, job := range jobs {
		graph[name] = job.Needs
	}
	var diags Diagnostics
	for _, found := range needsCycles(graph) {
		cycle := rotateToSmallest(found)
		first, next := cycle[0], cycle[1%len(cycle)]
		p := "checks.jobs." + first + ".needs"
		for i, need := range jobs[first].Needs {
			if need == next {
				p = joinIndex(p, i)
				break
			}
		}
		diags = append(diags, li.errorf(p, "remove one of these needs so the jobs can run in order",
			"cycle: %s -> %s", strings.Join(cycle, " -> "), first))
	}
	return diags
}

// needsCycles walks a needs graph depth first in name order. Every back edge
// closes one cycle, returned from the node the edge points at to the node
// whose need closes it; each node needs the next and the last needs the
// first. Needs on unknown nodes or on the node itself are skipped; callers
// report those separately.
func needsCycles(graph map[string][]string) [][]string {
	const (
		unvisited = iota
		onStack
		done
	)
	state := make(map[string]int, len(graph))
	var stack []string
	var cycles [][]string
	var visit func(name string)
	visit = func(name string) {
		state[name] = onStack
		stack = append(stack, name)
		for _, need := range graph[name] {
			if _, ok := graph[need]; !ok || need == name {
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
				cycles = append(cycles, slices.Clone(stack[i:]))
			}
		}
		stack = stack[:len(stack)-1]
		state[name] = done
	}
	for _, name := range sortedKeys(graph) {
		if state[name] == unvisited {
			visit(name)
		}
	}
	return cycles
}

// rotateToSmallest returns a copy of cycle starting at its smallest name.
func rotateToSmallest(cycle []string) []string {
	start := 0
	for i, name := range cycle {
		if name < cycle[start] {
			start = i
		}
	}
	return append(append([]string(nil), cycle[start:]...), cycle[:start]...)
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
		if _, err := ParseDuration(base+".timeout", l.Timeout); err != nil {
			diags = append(diags, validationDiagnostic(err.(ValidationError), li))
		}
	}
	limits("checks.limits", c.Limits)
	for _, name := range sortedKeys(c.Jobs) {
		job := c.Jobs[name]
		limits("checks.jobs."+name+".limits", job.Limits)
		if job.Timeout != nil {
			if _, err := ParseDuration("checks.jobs."+name+".timeout", *job.Timeout); err != nil {
				diags = append(diags, validationDiagnostic(err.(ValidationError), li))
			}
		}
	}
	return diags
}

// checkTrust refuses trust: all except on a self-hosted hub with no
// deployments, where only the operator's own runner is at stake.
func checkTrust(cfg *ZeroCIConfig, opts ParseOptions, li lineIndex) Diagnostics {
	if cfg.Checks == nil || cfg.Checks.Trust != ChecksTrustAll {
		return nil
	}
	if opts.SelfHosted && len(cfg.Deployments) == 0 {
		return nil
	}
	return Diagnostics{li.errorf("checks.trust", "use trust: collaborators, or self-host the hub without deployments",
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

// checkDeployments reports every ValidateDeployments problem, and warns about
// env_file permissions on this machine.
func checkDeployments(cfg *ZeroCIConfig, opts ParseOptions, li lineIndex) Diagnostics {
	var diags Diagnostics
	for _, e := range ValidateDeployments(cfg) {
		diags = append(diags, validationDiagnostic(e, li))
	}
	for _, env := range sortedKeys(cfg.Deployments) {
		if f := cfg.Deployments[env].EnvFile; f != nil && path.IsAbs(*f) {
			diags = append(diags, checkEnvFile(*f, "deployments."+env+".env_file", opts, li)...)
		}
	}
	return diags
}

// validationDiagnostic turns a ValidationError into an error Diagnostic on
// the line of its path.
func validationDiagnostic(e ValidationError, li lineIndex) Diagnostic {
	return li.errorf(e.Path, e.Fix, "%s", e.Msg)
}

// checkEnvFile warns when the env_file is missing, not owned by root, or
// writable by group or others. file is an absolute path.
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

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
