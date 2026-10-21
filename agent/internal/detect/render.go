package detect

import (
	"bytes"
	"errors"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/KCuppens/hookci/agent/internal/config"
)

// Render emits YAML equivalent to r.Config with r.Notes as a header comment.
// Keys are emitted in a fixed order: version, checks{setup, jobs, services}.
// Jobs are sorted by name. Only fields detection can set are rendered, so
// defaults filled in by config.FromRoot (trust, forks) are left implicit.
func Render(r *Result) ([]byte, error) {
	if r == nil || r.Config == nil {
		return nil, errors.New("render: no configuration")
	}
	root := r.Config.HookCIConfig

	doc := mapping()
	add(doc, "version", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.Itoa(root.Version)})
	if c := root.Checks; c != nil {
		checks := mapping()
		if len(c.Setup) > 0 {
			setup := &yaml.Node{Kind: yaml.SequenceNode}
			for _, step := range c.Setup {
				setup.Content = append(setup.Content, setupNode(step))
			}
			add(checks, "setup", setup)
		}
		if len(c.Jobs) > 0 {
			jobs := mapping()
			for _, name := range sortedKeys(c.Jobs) {
				job, err := jobNode(c.Jobs[name])
				if err != nil {
					return nil, err
				}
				add(jobs, name, job)
			}
			add(checks, "jobs", jobs)
		}
		if c.Services != nil && c.Services.Postgres != nil {
			pg := mapping()
			add(pg, "image", str(c.Services.Postgres.Image))
			add(pg, "tmpfs", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: strconv.FormatBool(c.Services.Postgres.Tmpfs)})
			services := mapping()
			add(services, "postgres", pg)
			add(checks, "services", services)
		}
		add(doc, "checks", checks)
	}

	var comment []string
	for _, note := range r.Notes {
		comment = append(comment, "# "+note)
	}
	out := &yaml.Node{Kind: yaml.DocumentNode, HeadComment: strings.Join(comment, "\n"), Content: []*yaml.Node{doc}}

	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(out); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func setupNode(step config.SetupStep) *yaml.Node {
	n := mapping()
	add(n, "run", str(step.Run))
	if step.Cache != nil {
		cache := mapping()
		add(cache, "key", flowList(step.Cache.Key))
		add(cache, "paths", flowList(step.Cache.Paths))
		add(n, "cache", cache)
	}
	return n
}

func jobNode(job config.Job) (*yaml.Node, error) {
	n := mapping()
	add(n, "run", str(job.Run))
	if len(job.Needs) > 0 {
		add(n, "needs", flowList(job.Needs))
	}
	if job.Annotate != nil {
		add(n, "annotate", str(string(*job.Annotate)))
	}
	if job.Timeout != nil {
		add(n, "timeout", str(*job.Timeout))
	}
	if job.Limits != nil {
		var limits yaml.Node
		if err := limits.Encode(job.Limits); err != nil {
			return nil, err
		}
		add(n, "limits", &limits)
	}
	return n, nil
}

func mapping() *yaml.Node {
	return &yaml.Node{Kind: yaml.MappingNode}
}

func add(m *yaml.Node, key string, value *yaml.Node) {
	m.Content = append(m.Content, str(key), value)
}

func str(s string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: s}
}

func flowList(items []string) *yaml.Node {
	n := &yaml.Node{Kind: yaml.SequenceNode, Style: yaml.FlowStyle}
	for _, item := range items {
		n.Content = append(n.Content, str(item))
	}
	return n
}
