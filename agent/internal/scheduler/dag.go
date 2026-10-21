package scheduler

import (
	"fmt"
	"sort"
	"strings"

	"github.com/KCuppens/hookci/agent/internal/store"
)

// Graph tracks the job states of one run. Jobs are ordered topologically with
// ties broken by name, and every list a Graph returns follows that order. A
// Graph is not safe for concurrent use; the Scheduler guards it with its mutex.
type Graph struct {
	order      []string
	index      map[string]int
	needs      map[string][]string
	dependents map[string][]string
	state      map[string]store.JobState
}

// NewGraph builds the graph of jobs. A job with an empty state counts as
// queued. Duplicate names, needs on unknown jobs and cycles are errors.
func NewGraph(jobs []store.Job) (*Graph, error) {
	g := &Graph{
		index:      make(map[string]int, len(jobs)),
		needs:      make(map[string][]string, len(jobs)),
		dependents: make(map[string][]string, len(jobs)),
		state:      make(map[string]store.JobState, len(jobs)),
	}
	for _, j := range jobs {
		if j.Name == "" {
			return nil, fmt.Errorf("scheduler: job with empty name")
		}
		if _, dup := g.state[j.Name]; dup {
			return nil, fmt.Errorf("scheduler: duplicate job %q", j.Name)
		}
		st := j.State
		if st == "" {
			st = store.JobQueued
		}
		g.state[j.Name] = st
	}

	indegree := make(map[string]int, len(jobs))
	for _, j := range jobs {
		seen := make(map[string]bool, len(j.Needs))
		for _, need := range j.Needs {
			if _, ok := g.state[need]; !ok {
				return nil, fmt.Errorf("scheduler: job %q needs unknown job %q", j.Name, need)
			}
			if seen[need] {
				continue
			}
			seen[need] = true
			g.needs[j.Name] = append(g.needs[j.Name], need)
			g.dependents[need] = append(g.dependents[need], j.Name)
			indegree[j.Name]++
		}
	}

	// Kahn's algorithm, always taking the smallest available name.
	var avail []string
	for name := range g.state {
		if indegree[name] == 0 {
			avail = append(avail, name)
		}
	}
	for len(avail) > 0 {
		sort.Strings(avail)
		name := avail[0]
		avail = avail[1:]
		g.index[name] = len(g.order)
		g.order = append(g.order, name)
		for _, d := range g.dependents[name] {
			indegree[d]--
			if indegree[d] == 0 {
				avail = append(avail, d)
			}
		}
	}
	if len(g.order) != len(g.state) {
		var cyclic []string
		for name := range g.state {
			if _, ok := g.index[name]; !ok {
				cyclic = append(cyclic, name)
			}
		}
		sort.Strings(cyclic)
		return nil, fmt.Errorf("scheduler: dependency cycle among jobs %s", strings.Join(cyclic, ", "))
	}
	for name := range g.dependents {
		g.sortByOrder(g.dependents[name])
	}
	return g, nil
}

// Ready returns the queued jobs whose needs all succeeded, in order.
func (g *Graph) Ready() []string {
	var ready []string
	for _, name := range g.order {
		if g.state[name] != store.JobQueued {
			continue
		}
		ok := true
		for _, need := range g.needs[name] {
			if g.state[need] != store.JobSuccess {
				ok = false
				break
			}
		}
		if ok {
			ready = append(ready, name)
		}
	}
	return ready
}

// MarkRunning records that name started.
func (g *Graph) MarkRunning(name string) {
	g.state[name] = store.JobRunning
}

// MarkDone records the final state of name. When st is failed or cancelled,
// every queued transitive dependent becomes skipped and is returned in order.
func (g *Graph) MarkDone(name string, st store.JobState) (skipped []string) {
	g.state[name] = st
	if st != store.JobFailed && st != store.JobCancelled {
		return nil
	}
	pending := append([]string(nil), g.dependents[name]...)
	for len(pending) > 0 {
		d := pending[0]
		pending = pending[1:]
		if g.state[d] != store.JobQueued {
			continue
		}
		g.state[d] = store.JobSkipped
		skipped = append(skipped, d)
		pending = append(pending, g.dependents[d]...)
	}
	g.sortByOrder(skipped)
	return skipped
}

// Abandon moves every queued job to st (skipped or interrupted) and returns
// those jobs in order. It is used when a run stops before its jobs can start.
func (g *Graph) Abandon(st store.JobState) []string {
	var names []string
	for _, name := range g.order {
		if g.state[name] == store.JobQueued {
			g.state[name] = st
			names = append(names, name)
		}
	}
	return names
}

// Done reports whether every job reached a terminal state.
func (g *Graph) Done() bool {
	for _, st := range g.state {
		if !st.Terminal() {
			return false
		}
	}
	return true
}

// Final is the run state the job states imply: success when every job
// succeeded (or there are no jobs), failed otherwise.
func (g *Graph) Final() store.RunState {
	for _, st := range g.state {
		if st != store.JobSuccess {
			return store.RunFailed
		}
	}
	return store.RunSuccess
}

func (g *Graph) sortByOrder(names []string) {
	sort.Slice(names, func(i, j int) bool { return g.index[names[i]] < g.index[names[j]] })
}
