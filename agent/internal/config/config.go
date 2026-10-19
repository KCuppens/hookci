package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"gopkg.in/yaml.v3"
)

var (
	// ErrEmptyConfig is returned when the configuration file is empty.
	ErrEmptyConfig = errors.New("empty configuration")

	// ErrSchemaValidation is returned when the configuration does not conform to the schema.
	ErrSchemaValidation = errors.New("schema validation failed")

	// ErrNoChecks is returned when no checks are configured.
	ErrNoChecks = errors.New("at least one check job must be defined")

	// ErrUnknownJob is returned when a job depends on a non-existent job.
	ErrUnknownJob = errors.New("unknown dependency job")

	// ErrCyclicDependency is returned when check jobs have a cyclic dependency.
	ErrCyclicDependency = errors.New("cyclic dependency detected")

	// ErrInvalidIdentifier is returned when a job name does not match the schema's propertyNames pattern.
	ErrInvalidIdentifier = errors.New("invalid identifier")

	// ErrInvalidPath is returned when a path is invalid or unsafe.
	ErrInvalidPath = errors.New("invalid path")
)

const schemaURL = "https://ci.webuno.io/schema/zeroci.schema.json"

var getCompiledSchema = sync.OnceValues(func() (*jsonschema.Schema, error) {
	c := jsonschema.NewCompiler()
	sch, err := jsonschema.UnmarshalJSON(strings.NewReader(string(SchemaJSON)))
	if err != nil {
		return nil, fmt.Errorf("unmarshal schema: %w", err)
	}
	if err := c.AddResource(schemaURL, sch); err != nil {
		return nil, fmt.Errorf("add schema resource: %w", err)
	}
	return c.Compile(schemaURL)
})

// jobNameRegex mirrors $defs.Checks.jobs.propertyNames so configs built in code
// (detect) get the same check as parsed ones.
var jobNameRegex = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)

// Config is a parsed .zeroci.yml. Its fields come from the generated root type.
type Config struct {
	ZeroCIConfig `yaml:",inline"`
}

// Load reads and validates the configuration from the given file path.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	cfg, err := Parse(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return cfg, nil
}

// Parse decodes YAML data, validates it against the JSON schema, and checks semantic constraints.
func Parse(data []byte) (*Config, error) {
	if len(strings.TrimSpace(string(data))) == 0 {
		return nil, ErrEmptyConfig
	}

	var raw any
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("yaml parse error: %w", err)
	}

	compiled, err := getCompiledSchema()
	if err != nil {
		return nil, fmt.Errorf("compile schema: %w", err)
	}

	if err := compiled.Validate(raw); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrSchemaValidation, err)
	}

	// Decode through JSON so the generated UnmarshalJSON methods fill schema defaults.
	doc, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("re-encode config: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(doc, &cfg.ZeroCIConfig); err != nil {
		return nil, fmt.Errorf("decode config: %w", err)
	}

	if err := ValidateSemantics(&cfg); err != nil {
		return nil, err
	}

	return &cfg, nil
}

// ValidateSemantics enforces business invariants on the decoded configuration.
func ValidateSemantics(cfg *Config) error {
	if cfg.Version != 1 {
		return fmt.Errorf("unsupported config version: %d (expected 1)", cfg.Version)
	}

	if cfg.Checks == nil || len(cfg.Checks.Jobs) == 0 {
		return ErrNoChecks
	}

	for i, step := range cfg.Checks.Setup {
		if strings.TrimSpace(step.Run) == "" {
			return fmt.Errorf("setup step [%d]: command cannot be empty", i)
		}
		if step.Cache == nil {
			continue
		}
		for _, p := range step.Cache.Paths {
			cleanPath := filepath.Clean(p)
			if filepath.IsAbs(cleanPath) || cleanPath == ".." || strings.HasPrefix(cleanPath, ".."+string(filepath.Separator)) {
				return fmt.Errorf("%w: setup step [%d] cache path %q must be relative to repository root", ErrInvalidPath, i, p)
			}
		}
	}

	for name, job := range cfg.Checks.Jobs {
		if !jobNameRegex.MatchString(name) {
			return fmt.Errorf("%w: check job name %q does not match pattern %s", ErrInvalidIdentifier, name, jobNameRegex.String())
		}
		if strings.TrimSpace(job.Run) == "" {
			return fmt.Errorf("check job %q: run command cannot be empty", name)
		}
		for _, need := range job.Needs {
			if need == name {
				return fmt.Errorf("%w: check job %q cannot depend on itself", ErrCyclicDependency, name)
			}
			if _, ok := cfg.Checks.Jobs[need]; !ok {
				return fmt.Errorf("%w: check job %q depends on undefined job %q", ErrUnknownJob, name, need)
			}
		}
	}

	if _, err := cfg.TopologicalSort(); err != nil {
		return err
	}

	return nil
}

// TopologicalSort returns job names in dependency order (dependencies before dependents).
// If a dependency cycle exists, ErrCyclicDependency is returned.
func (c *Config) TopologicalSort() ([]string, error) {
	var jobs ChecksJobs
	if c.Checks != nil {
		jobs = c.Checks.Jobs
	}
	inDegree := make(map[string]int, len(jobs))
	dependents := make(map[string][]string, len(jobs))

	for name := range jobs {
		inDegree[name] = 0
	}

	for name, job := range jobs {
		for _, need := range job.Needs {
			dependents[need] = append(dependents[need], name)
			inDegree[name]++
		}
	}

	// Queue nodes with in-degree 0 (no dependencies)
	var queue []string
	for name, deg := range inDegree {
		if deg == 0 {
			queue = append(queue, name)
		}
	}
	sort.Strings(queue)

	var ordered []string
	for len(queue) > 0 {
		curr := queue[0]
		queue = queue[1:]
		ordered = append(ordered, curr)

		for _, dep := range dependents[curr] {
			inDegree[dep]--
			if inDegree[dep] == 0 {
				queue = append(queue, dep)
				sort.Strings(queue)
			}
		}
	}

	if len(ordered) != len(jobs) {
		// Identify jobs involved in cycle
		var unvisited []string
		for name, deg := range inDegree {
			if deg > 0 {
				unvisited = append(unvisited, name)
			}
		}
		sort.Strings(unvisited)
		return nil, fmt.Errorf("%w: %s", ErrCyclicDependency, strings.Join(unvisited, ", "))
	}

	return ordered, nil
}
