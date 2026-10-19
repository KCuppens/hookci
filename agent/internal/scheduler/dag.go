package scheduler

import (
	"errors"
	"fmt"
	"sort"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
)

var (
	ErrCycleDetected = errors.New("cycle detected in job dependencies")
	ErrMissingDep    = errors.New("dependency not found in check jobs")
)

// Node represents a job in the DAG with its dependencies and dependents.
type Node struct {
	Name       string
	Needs      []string
	DependedBy []string
}

// DAG represents the directed acyclic graph of check jobs.
type DAG struct {
	Nodes map[string]*Node
}

// BuildDAG creates a DAG from the provided check jobs map.
func BuildDAG(checks config.ConfigChecks) (*DAG, error) {
	dag := &DAG{
		Nodes: make(map[string]*Node, len(checks)),
	}

	for name, job := range checks {
		seen := make(map[string]bool, len(job.Needs))
		var uniqueNeeds []string
		for _, dep := range job.Needs {
			if !seen[dep] {
				seen[dep] = true
				uniqueNeeds = append(uniqueNeeds, dep)
			}
		}
		dag.Nodes[name] = &Node{
			Name:  name,
			Needs: uniqueNeeds,
		}
	}

	// Validate dependencies exist and populate DependedBy
	for name, node := range dag.Nodes {
		for _, dep := range node.Needs {
			depNode, exists := dag.Nodes[dep]
			if !exists {
				return nil, fmt.Errorf("%w: job %q needs %q", ErrMissingDep, name, dep)
			}
			depNode.DependedBy = append(depNode.DependedBy, name)
		}
	}

	// Cycle detection using Kahn's algorithm
	inDegree := make(map[string]int, len(dag.Nodes))
	for name, node := range dag.Nodes {
		inDegree[name] = len(node.Needs)
	}

	var queue []string
	for name, deg := range inDegree {
		if deg == 0 {
			queue = append(queue, name)
		}
	}

	visited := 0
	for len(queue) > 0 {
		curr := queue[0]
		queue = queue[1:]
		visited++

		for _, dep := range dag.Nodes[curr].DependedBy {
			inDegree[dep]--
			if inDegree[dep] == 0 {
				queue = append(queue, dep)
			}
		}
	}

	if visited != len(dag.Nodes) {
		return nil, ErrCycleDetected
	}

	return dag, nil
}

// InitialReady returns the jobs that have no dependencies (in-degree 0),
// sorted alphabetically for deterministic scheduling.
func (d *DAG) InitialReady() []string {
	var ready []string
	for name, node := range d.Nodes {
		if len(node.Needs) == 0 {
			ready = append(ready, name)
		}
	}
	sort.Strings(ready)
	return ready
}

// Dependents returns the jobs that depend on the given job name.
func (d *DAG) Dependents(name string) []string {
	node, exists := d.Nodes[name]
	if !exists {
		return nil
	}
	deps := make([]string, len(node.DependedBy))
	copy(deps, node.DependedBy)
	sort.Strings(deps)
	return deps
}
