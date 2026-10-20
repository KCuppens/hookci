// Package compose generates the per-color Docker Compose override and the
// names the compose strategies use for projects and images.
package compose

import (
	"bytes"
	"fmt"
	"maps"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

var (
	projectRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)
	shaRE     = regexp.MustCompile(`^[0-9a-fA-F]{7,}$`)
)

// OverrideInput describes the override for one color of one deployment.
type OverrideInput struct {
	Env           string // deployment name, for config paths in errors
	ComposeFile   string // user compose file (read only, to discover container port and container_name)
	Service       string
	Image         string // "<project>:<sha7>"
	HostPort      int    // from store.AllocatePort; 0 keeps the user's ports and container_name
	Color         string
	SharedNetwork string // optional external network
}

// ProjectName returns the compose project of one color, "<project>-<color>".
func ProjectName(project, color string) (string, error) {
	if err := validateProject(project); err != nil {
		return "", err
	}
	if !projectRE.MatchString(color) {
		return "", fmt.Errorf("compose: color %q must match %s", color, projectRE)
	}
	return project + "-" + color, nil
}

// ImageTag returns the immutable image tag of a commit, "<project>:<sha[:7]>".
func ImageTag(project, sha string) (string, error) {
	if err := validateProject(project); err != nil {
		return "", err
	}
	if !shaRE.MatchString(sha) {
		return "", fmt.Errorf("compose: sha %q must be at least 7 hex characters", sha)
	}
	return project + ":" + sha[:7], nil
}

// validateProject returns an error starting with the config path relative to
// deployments.<env>, so callers can prefix it.
func validateProject(project string) error {
	if !projectRE.MatchString(project) {
		return fmt.Errorf("compose.project: %q is not a valid compose project name; use lowercase letters, digits, \"_\" and \"-\", starting with a letter or digit", project)
	}
	return nil
}

// baseService is the part of a user compose service the override depends on.
type baseService struct {
	Ports         []yaml.Node `yaml:"ports"`
	Expose        []yaml.Node `yaml:"expose"`
	ContainerName yaml.Node   `yaml:"container_name"`
}

// RenderOverride reads the user compose file and returns the override YAML
// that pins in.Image, binds the service to 127.0.0.1:<HostPort> on its
// container port, and joins the shared network when given. Two colors run
// side by side, so with a HostPort it also clears the host ports and
// container_name of every other service in the file, and the container_name
// of the service itself. With HostPort 0 (compose-inplace, one project) it
// keeps the user's ports and container_name. Keys are sorted so the output
// is stable.
func RenderOverride(in OverrideInput) ([]byte, error) {
	services, err := readServices(in.ComposeFile)
	if err != nil {
		return nil, err
	}
	svc, err := lookupService(services, in.Env, in.ComposeFile, in.Service)
	if err != nil {
		return nil, err
	}
	overrides := map[string]*yaml.Node{}
	service := map[string]*yaml.Node{"image": scalar("!!str", in.Image)}
	if in.HostPort != 0 {
		containerPort, err := firstContainerPort(svc)
		if err != nil {
			return nil, fmt.Errorf("deployments.%s.compose.service: service %s %w", in.Env, in.Service, err)
		}
		for name, other := range services {
			if name == in.Service {
				continue
			}
			cleared := map[string]*yaml.Node{}
			if len(other.Ports) > 0 {
				cleared["ports"] = &yaml.Node{Kind: yaml.SequenceNode, Tag: "!reset", Style: yaml.FlowStyle}
			}
			if other.ContainerName.Kind != 0 {
				cleared["container_name"] = scalar("!reset", "null")
			}
			if len(cleared) > 0 {
				overrides[name] = mapping(cleared)
			}
		}
		service["ports"] = &yaml.Node{
			Kind:    yaml.SequenceNode,
			Tag:     "!override",
			Content: []*yaml.Node{quoted(fmt.Sprintf("127.0.0.1:%d:%d", in.HostPort, containerPort))},
		}
		if svc.ContainerName.Kind != 0 {
			service["container_name"] = scalar("!reset", "null")
		}
	}
	top := map[string]*yaml.Node{}
	if in.SharedNetwork != "" {
		service["networks"] = mapping(map[string]*yaml.Node{
			"default":        mapping(nil),
			in.SharedNetwork: mapping(nil),
		})
		top["networks"] = mapping(map[string]*yaml.Node{
			in.SharedNetwork: mapping(map[string]*yaml.Node{"external": scalar("!!bool", "true")}),
		})
	}
	overrides[in.Service] = mapping(service)
	top["services"] = mapping(overrides)

	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{mapping(top)}}); err != nil {
		return nil, fmt.Errorf("compose: encoding override: %w", err)
	}
	if err := enc.Close(); err != nil {
		return nil, fmt.Errorf("compose: encoding override: %w", err)
	}
	return buf.Bytes(), nil
}

// readServices returns the services of the user compose file at path.
func readServices(path string) (map[string]baseService, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("compose: reading %s: %w", path, err)
	}
	var base struct {
		Services map[string]baseService `yaml:"services"`
	}
	if err := yaml.Unmarshal(raw, &base); err != nil {
		return nil, fmt.Errorf("compose: parsing %s: %w", path, err)
	}
	return base.Services, nil
}

// lookupService returns service from services, read from the compose file at
// path, with an error naming deployments.<env>.compose.service when missing.
func lookupService(services map[string]baseService, env, path, service string) (baseService, error) {
	svc, ok := services[service]
	if !ok {
		return baseService{}, fmt.Errorf("deployments.%s.compose.service: service %s not found in %s; set compose.service to a service in that file",
			env, service, path)
	}
	return svc, nil
}

// PublishedPort returns the fixed host port the first ports entry of
// service publishes in the user compose file at path: 3000 for "3000:8080"
// or "127.0.0.1:3000:8080/tcp", or the published field of a long-syntax
// entry.
func PublishedPort(env, path, service string) (int, error) {
	services, err := readServices(path)
	if err != nil {
		return 0, err
	}
	svc, err := lookupService(services, env, path, service)
	if err != nil {
		return 0, err
	}
	if len(svc.Ports) == 0 {
		return 0, fmt.Errorf("deployments.%s.compose.service: service %s publishes no port; add ports with a fixed host port, for example \"127.0.0.1:8080:8080\"",
			env, service)
	}
	n := &svc.Ports[0]
	if n.Kind == yaml.AliasNode {
		n = n.Alias
	}
	var host string
	switch n.Kind {
	case yaml.ScalarNode:
		spec, _, _ := strings.Cut(n.Value, "/")
		if i := strings.LastIndexByte(spec, ':'); i >= 0 {
			spec = spec[:i]
			host = spec[strings.LastIndexByte(spec, ':')+1:]
		}
	case yaml.MappingNode:
		var long struct {
			Published yaml.Node `yaml:"published"`
		}
		if err := n.Decode(&long); err != nil {
			return 0, fmt.Errorf("deployments.%s.compose.service: service %s has an unreadable ports entry: %w", env, service, err)
		}
		host = long.Published.Value
	}
	port, err := strconv.Atoi(host)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("deployments.%s.compose.service: service %s publishes no fixed host port in the ports entry at line %d; publish one, for example \"127.0.0.1:8080:8080\"",
			env, service, n.Line)
	}
	return port, nil
}

// firstContainerPort returns the container port of the first ports entry, or
// of the first expose entry when the service publishes none. The error text
// completes "service <name> ...".
func firstContainerPort(svc baseService) (int, error) {
	switch {
	case len(svc.Ports) > 0:
		return portEntry(&svc.Ports[0], true)
	case len(svc.Expose) > 0:
		return portEntry(&svc.Expose[0], false)
	}
	return 0, fmt.Errorf("exposes no port; add ports or expose")
}

// portEntry parses one ports or expose entry: a number, a short-syntax string
// such as "127.0.0.1:3000:8080/tcp", or (ports only) a long-syntax mapping
// with target.
func portEntry(n *yaml.Node, published bool) (int, error) {
	if n.Kind == yaml.AliasNode {
		n = n.Alias
	}
	var spec string
	switch {
	case n.Kind == yaml.ScalarNode:
		spec = n.Value
		if published {
			spec = spec[strings.LastIndexByte(spec, ':')+1:]
		}
	case n.Kind == yaml.MappingNode && published:
		var long struct {
			Target yaml.Node `yaml:"target"`
		}
		if err := n.Decode(&long); err != nil {
			return 0, fmt.Errorf("has an unreadable ports entry: %w", err)
		}
		spec = long.Target.Value
	default:
		return 0, fmt.Errorf("has an unreadable port entry at line %d; use a single container port", n.Line)
	}
	spec, _, _ = strings.Cut(spec, "/")
	port, err := strconv.Atoi(spec)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("has no single container port in the entry at line %d; use one numeric container port", n.Line)
	}
	return port, nil
}

func scalar(tag, value string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: tag, Value: value}
}

func quoted(value string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value, Style: yaml.DoubleQuotedStyle}
}

// mapping returns a mapping node with keys in sorted order; an empty map
// renders as {}.
func mapping(m map[string]*yaml.Node) *yaml.Node {
	n := &yaml.Node{Kind: yaml.MappingNode}
	if len(m) == 0 {
		n.Style = yaml.FlowStyle
		return n
	}
	for _, k := range slices.Sorted(maps.Keys(m)) {
		n.Content = append(n.Content, scalar("!!str", k), m[k])
	}
	return n
}
