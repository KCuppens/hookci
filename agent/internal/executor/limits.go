package executor

import (
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// JobPATH is the PATH jobs get unless the isolation backend is "none".
const JobPATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// UntrustedCap bounds every limit of a run in an untrusted: trust domain.
var UntrustedCap = isolation.Limits{CPUs: 2, MemoryBytes: 2 << 30, Timeout: 10 * time.Minute}

// EffectiveLimits merges the job's limits over the check-level limits; a
// zero job field keeps the check-level value. For an untrusted run each of
// CPUs, MemoryBytes and Timeout is clamped to UntrustedCap, and an unset
// (zero) value becomes the cap. Tasks is not clamped.
func EffectiveLimits(run store.Run, checks config.ResolvedLimits, job config.ResolvedJob) isolation.Limits {
	l := isolation.Limits{
		CPUs:        pick(job.Limits.CPUs, checks.CPUs),
		MemoryBytes: pick(job.Limits.MemoryBytes, checks.MemoryBytes),
		Tasks:       pick(job.Limits.Tasks, checks.Tasks),
		Timeout:     pick(job.Limits.Timeout, checks.Timeout),
	}
	if strings.HasPrefix(run.TrustDomain, "untrusted:") {
		l.CPUs = clamp(l.CPUs, UntrustedCap.CPUs)
		l.MemoryBytes = clamp(l.MemoryBytes, UntrustedCap.MemoryBytes)
		l.Timeout = clamp(l.Timeout, UntrustedCap.Timeout)
	}
	return l
}

func pick[T comparable](job, checks T) T {
	var zero T
	if job != zero {
		return job
	}
	return checks
}

func clamp[T float64 | int64 | time.Duration](v, limit T) T {
	if v <= 0 || v > limit {
		return limit
	}
	return v
}
