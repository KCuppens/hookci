package config

import (
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

	// ErrUnknownService is returned when a check job references an undefined service.
	ErrUnknownService = errors.New("unknown service")

	// ErrInvalidIdentifier is returned when an identifier format is invalid.
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

var identRegex = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$`)

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

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("yaml decode: %w", err)
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

	if len(cfg.Checks) == 0 {
		return ErrNoChecks
	}

	// Validate setup commands
	for i, step := range cfg.Setup {
		if strings.TrimSpace(step) == "" {
			return fmt.Errorf("setup step [%d]: command cannot be empty", i)
		}
	}

	// Validate services
	for name, svc := range cfg.Services {
		if !identRegex.MatchString(name) {
			return fmt.Errorf("%w: service name %q does not match pattern %s", ErrInvalidIdentifier, name, identRegex.String())
		}
		if strings.TrimSpace(svc.Image) == "" {
			return fmt.Errorf("service %q: image cannot be empty", name)
		}
	}

	// Validate caches
	for name, cache := range cfg.Caches {
		if !identRegex.MatchString(name) {
			return fmt.Errorf("%w: cache name %q does not match pattern %s", ErrInvalidIdentifier, name, identRegex.String())
		}
		if strings.TrimSpace(cache.Key) == "" {
			return fmt.Errorf("cache %q: key cannot be empty", name)
		}
		cleanPath := filepath.Clean(cache.Path)
		if filepath.IsAbs(cleanPath) || cleanPath == ".." || strings.HasPrefix(cleanPath, ".."+string(filepath.Separator)) {
			return fmt.Errorf("%w: cache %q path %q must be relative to repository root", ErrInvalidPath, name, cache.Path)
		}
	}

	// Validate check jobs and build DAG
	for name, job := range cfg.Checks {
		if !identRegex.MatchString(name) {
			return fmt.Errorf("%w: check job name %q does not match pattern %s", ErrInvalidIdentifier, name, identRegex.String())
		}
		if strings.TrimSpace(job.Run) == "" {
			return fmt.Errorf("check job %q: run command cannot be empty", name)
		}
		for _, svc := range job.Services {
			if _, ok := cfg.Services[svc]; !ok {
				return fmt.Errorf("%w: check job %q references undefined service %q", ErrUnknownService, name, svc)
			}
		}
		for _, need := range job.Needs {
			if need == name {
				return fmt.Errorf("%w: check job %q cannot depend on itself", ErrCyclicDependency, name)
			}
			if _, ok := cfg.Checks[need]; !ok {
				return fmt.Errorf("%w: check job %q depends on undefined job %q", ErrUnknownJob, name, need)
			}
		}
	}

	// Detect cycles in check DAG
	if _, err := cfg.TopologicalSort(); err != nil {
		return err
	}

	// Validate egress hosts
	for i, host := range cfg.Egress {
		trimmed := strings.TrimSpace(host)
		if trimmed == "" {
			return fmt.Errorf("egress host [%d] cannot be empty", i)
		}
		if strings.Contains(trimmed, "://") || strings.Contains(trimmed, "/") {
			return fmt.Errorf("egress host %q must be a bare hostname or domain, not a URL", host)
		}
	}

	return nil
}

// TopologicalSort returns job names in dependency order (dependencies before dependents).
// If a dependency cycle exists, ErrCyclicDependency is returned.
func (c *Config) TopologicalSort() ([]string, error) {
	inDegree := make(map[string]int, len(c.Checks))
	dependents := make(map[string][]string, len(c.Checks))

	for name := range c.Checks {
		inDegree[name] = 0
	}

	for name, job := range c.Checks {
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

	if len(ordered) != len(c.Checks) {
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
