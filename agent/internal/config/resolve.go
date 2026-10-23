package config

import (
	"regexp"
	"slices"
	"sort"
	"time"
)

// ResolvedChecks is the checks section with every default applied, job
// limits merged over the check-level limits and jobs in dependency order.
type ResolvedChecks struct {
	Trust    string
	Forks    string
	Limits   ResolvedLimits
	Setup    []SetupStep
	Jobs     []ResolvedJob // topologically sorted, ties by name
	Services Services
	Egress   []string
	Redact   []*regexp.Regexp
	// EnvFiles are the deployments' env_file paths, sorted. Their values are
	// never given to check jobs; the executor masks them in job logs.
	EnvFiles []string
	// LogsLocal is true for `logs: local`: job logs stay on the agent and are
	// not uploaded to the hub.
	LogsLocal bool
}

// Services are the sidecars started next to the jobs.
type Services struct {
	Postgres *PostgresService
}

// PostgresService is the postgres sidecar.
type PostgresService struct {
	Image string
	Tmpfs bool
}

// ResolvedJob is one check job with its effective limits.
type ResolvedJob struct {
	Name     string
	Run      string
	Needs    []string
	Annotate string
	Limits   ResolvedLimits
}

// ResolvedLimits are the effective resource limits of a job.
type ResolvedLimits struct {
	CPUs float64
	// MaxCPUs caps how much idle CPU may be lent to the job; 0 means the
	// whole CPU budget of the agent.
	MaxCPUs     float64
	MemoryBytes int64
	Tasks       int
	Timeout     time.Duration
}

var defaultLimits = ResolvedLimits{
	CPUs:        2,
	MemoryBytes: 4 << 30,
	Tasks:       512,
	Timeout:     10 * time.Minute,
}

// resolveChecks builds the resolved view of a configuration that passed
// every check. raw is the decoded document; it tells which limit keys the
// file sets, since the generated types fill unset keys with defaults and
// would hide the check-level values a job should inherit.
func resolveChecks(cfg *HookCIConfig, raw any) *ResolvedChecks {
	rc := &ResolvedChecks{
		Trust:  string(ChecksTrustCollaborators),
		Forks:  string(ChecksForksGated),
		Limits: defaultLimits,
		Jobs:   []ResolvedJob{},
	}
	rc.LogsLocal = cfg.Logs == HookCIConfigLogsLocal
	for _, p := range cfg.Redact {
		rc.Redact = append(rc.Redact, regexp.MustCompile(p)) // checkRedact compiled it already
	}
	for _, d := range cfg.Deployments {
		if d.EnvFile != nil {
			rc.EnvFiles = append(rc.EnvFiles, *d.EnvFile)
		}
	}
	sort.Strings(rc.EnvFiles)
	rc.EnvFiles = slices.Compact(rc.EnvFiles)
	c := cfg.Checks
	if c == nil {
		return rc
	}
	rawChecks := mapAt(raw, "checks")

	rc.Trust = string(c.Trust)
	rc.Forks = string(c.Forks)
	rc.Limits = mergeLimits(defaultLimits, c.Limits, mapAt(rawChecks, "limits"))
	rc.Setup = c.Setup
	if c.Services != nil && c.Services.Postgres != nil {
		rc.Services.Postgres = &PostgresService{Image: c.Services.Postgres.Image, Tmpfs: c.Services.Postgres.Tmpfs}
	}
	rc.Egress = c.Egress

	rawJobs := mapAt(rawChecks, "jobs")
	for _, name := range topoSort(c.Jobs) {
		job := c.Jobs[name]
		rj := ResolvedJob{
			Name:   name,
			Run:    job.Run,
			Needs:  job.Needs,
			Limits: mergeLimits(rc.Limits, job.Limits, mapAt(mapAt(rawJobs, name), "limits")),
		}
		if job.Annotate != nil {
			rj.Annotate = string(*job.Annotate)
		}
		if job.Timeout != nil {
			rj.Limits.Timeout, _ = ParseDuration("checks.jobs."+name+".timeout", *job.Timeout) // checkLimits parsed it already
		}
		rc.Jobs = append(rc.Jobs, rj)
	}
	return rc
}

// mergeLimits overrides base with the keys the file sets in l. The values
// were already parsed by checkLimits, so parse errors cannot happen here.
func mergeLimits(base ResolvedLimits, l *Limits, set map[string]any) ResolvedLimits {
	if l == nil {
		return base
	}
	if _, ok := set["cpus"]; ok {
		base.CPUs = l.Cpus
	}
	if _, ok := set["max_cpus"]; ok {
		base.MaxCPUs = *l.MaxCpus
	}
	if _, ok := set["memory"]; ok {
		base.MemoryBytes, _ = ParseMemory(l.Memory)
	}
	if _, ok := set["tasks"]; ok {
		base.Tasks = l.Tasks
	}
	if _, ok := set["timeout"]; ok {
		base.Timeout, _ = ParseDuration("limits.timeout", l.Timeout)
	}
	return base
}

// mapAt returns the mapping under key in v, or nil.
func mapAt(v any, key string) map[string]any {
	m, _ := v.(map[string]any)
	child, _ := m[key].(map[string]any)
	return child
}

// topoSort orders jobs so every job comes after the jobs it needs, using
// Kahn's algorithm and taking ready jobs in name order. checkNeeds has
// already rejected unknown needs and cycles.
func topoSort(jobs ChecksJobs) []string {
	indegree := make(map[string]int, len(jobs))
	dependents := make(map[string][]string, len(jobs))
	for name, job := range jobs {
		indegree[name] = len(job.Needs) // the schema makes needs unique
		for _, need := range job.Needs {
			dependents[need] = append(dependents[need], name)
		}
	}
	var ready []string
	for name, n := range indegree {
		if n == 0 {
			ready = append(ready, name)
		}
	}
	order := make([]string, 0, len(jobs))
	for len(ready) > 0 {
		sort.Strings(ready)
		name := ready[0]
		ready = ready[1:]
		order = append(order, name)
		for _, dep := range dependents[name] {
			if indegree[dep]--; indegree[dep] == 0 {
				ready = append(ready, dep)
			}
		}
	}
	return order
}
