// Package initdeploy implements hookci init --deploy: it finds the
// repository's Docker Compose file, picks the web service and appends a
// deployments.production block to .hookci.yml that passes
// config.ValidateDeployments.
package initdeploy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/KCuppens/hookci/agent/internal/config"
)

// ComposeNames are the compose file names FindComposeFile looks for, in the
// order Docker Compose itself prefers them.
var ComposeNames = []string{"compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"}

const (
	configName        = ".hookci.yml"
	environment       = "production"
	defaultHealthPath = "/healthz"
)

// Options configures Run.
type Options struct {
	Dir  string    // repo root
	Repo string    // repo short name, used in paths
	Yes  bool      // accept defaults, no prompts
	In   io.Reader // answers to the prompts; read only when Yes is false
	Out  io.Writer // prompts and next steps
}

// FindComposeFile returns the name of the first of ComposeNames that is a
// regular file in dir.
func FindComposeFile(dir string) (string, error) {
	for _, name := range ComposeNames {
		info, err := os.Stat(filepath.Join(dir, name))
		switch {
		case err == nil && info.Mode().IsRegular():
			return name, nil
		case err != nil && !errors.Is(err, fs.ErrNotExist):
			return "", fmt.Errorf("init --deploy: %w", err)
		}
	}
	last := len(ComposeNames) - 1
	return "", fmt.Errorf("init --deploy: no %s or %s in %s", strings.Join(ComposeNames[:last], ", "), ComposeNames[last], dir)
}

// CandidateServices returns the services of a compose file that have both a
// build and at least one published port, sorted by name.
func CandidateServices(composeYAML []byte) ([]string, error) {
	var doc map[string]any
	if err := yaml.Unmarshal(composeYAML, &doc); err != nil {
		return nil, fmt.Errorf("init --deploy: parse compose file: %w", err)
	}
	services, _ := doc["services"].(map[string]any)
	var names []string
	for name, v := range services {
		svc, _ := v.(map[string]any)
		ports, _ := svc["ports"].([]any)
		if svc["build"] != nil && len(ports) > 0 {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	return names, nil
}

// Draft returns the mapping holding the deployments.production block for a
// compose-bluegreen deployment of service from the compose file at file.
func Draft(project, file, service, healthPath, repo string) *yaml.Node {
	return mapping(
		str("deployments"), mapping(
			str(environment), mapping(
				str("on"), mapping(str("push"), str("main"), str("after"), str("checks")),
				str("strategy"), str("compose-bluegreen"),
				str("compose"), mapping(str("project"), str(project), str("file"), str(file), str("service"), str(service)),
				str("route"), mapping(str("kind"), str("caddy"), str("file"), str(routeFile(repo)), str("upstream_host"), str("127.0.0.1")),
				str("health"), mapping(str("url"), str("http://127.0.0.1:{port}"+healthPath)),
				str("env_file"), str(envFile(repo)),
			),
		),
	)
}

// Run drafts deployments.production for the repository at opts.Dir and
// appends it to its .hookci.yml, creating the file when it is absent. The
// existing bytes of the file are kept as they are. Nothing is written when
// the file already has deployments or the result fails ValidateDeployments.
func Run(opts Options) error {
	path := filepath.Join(opts.Dir, configName)
	original, mode, err := readConfig(path)
	if err != nil {
		return err
	}
	doc, err := parseConfig(original)
	if err != nil {
		return err
	}
	root := doc.Content[0]
	for i := 0; i < len(root.Content); i += 2 {
		if root.Content[i].Value == "deployments" {
			return errors.New("deployments: already present in .hookci.yml; edit it or remove it to re-run init --deploy")
		}
	}

	file, err := FindComposeFile(opts.Dir)
	if err != nil {
		return err
	}
	compose, err := os.ReadFile(filepath.Join(opts.Dir, file))
	if err != nil {
		return fmt.Errorf("init --deploy: %w", err)
	}
	candidates, err := CandidateServices(compose)
	if err != nil {
		return err
	}
	if len(candidates) == 0 {
		return fmt.Errorf("init --deploy: no service with both build and ports in %s; add ports to your web service", file)
	}

	in := bufio.NewReader(opts.In)
	service, err := chooseService(opts, in, file, candidates)
	if err != nil {
		return err
	}
	healthPath, err := askHealthPath(opts, in)
	if err != nil {
		return err
	}

	draft := Draft(projectName(opts.Repo), file, service, healthPath, opts.Repo)
	root.Content = append(root.Content, draft.Content...)
	content, err := render(original, doc, draft)
	if err != nil {
		return err
	}
	if err := validate(content); err != nil {
		return err
	}
	if err := writeAtomic(path, content, mode); err != nil {
		return fmt.Errorf("init --deploy: %w", err)
	}
	printNextSteps(opts.Out, path, opts.Repo)
	return nil
}

// readConfig returns the bytes and permissions of the config file, or no
// bytes and 0644 when it does not exist.
func readConfig(path string) ([]byte, fs.FileMode, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, 0o644, nil
	}
	if err != nil {
		return nil, 0, fmt.Errorf("init --deploy: %w", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, 0, fmt.Errorf("init --deploy: %w", err)
	}
	return data, info.Mode().Perm(), nil
}

// parseConfig parses the config file into a document whose root is a
// mapping. An empty or comment-only file becomes a document holding
// version: 1.
func parseConfig(data []byte) (*yaml.Node, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("init --deploy: parse %s: %w", configName, err)
	}
	if doc.Kind == 0 {
		doc.Kind = yaml.DocumentNode
	}
	if len(doc.Content) == 0 {
		doc.Content = []*yaml.Node{mapping(str("version"), &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: "1"})}
	}
	if doc.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("init --deploy: %s is not a mapping", configName)
	}
	return &doc, nil
}

func chooseService(opts Options, in *bufio.Reader, file string, candidates []string) (string, error) {
	if opts.Yes || len(candidates) == 1 {
		return candidates[0], nil
	}
	fmt.Fprintf(opts.Out, "Services with both build and ports in %s:\n", file)
	for i, name := range candidates {
		fmt.Fprintf(opts.Out, "  %d) %s\n", i+1, name)
	}
	fmt.Fprint(opts.Out, "Service to deploy [1]: ")
	answer, err := readAnswer(in)
	if err != nil {
		return "", err
	}
	if answer == "" {
		return candidates[0], nil
	}
	n, err := strconv.Atoi(answer)
	if err != nil || n < 1 || n > len(candidates) {
		return "", fmt.Errorf("init --deploy: invalid service choice %q; enter a number from 1 to %d", answer, len(candidates))
	}
	return candidates[n-1], nil
}

func askHealthPath(opts Options, in *bufio.Reader) (string, error) {
	if opts.Yes {
		return defaultHealthPath, nil
	}
	fmt.Fprintf(opts.Out, "Health check path [%s]: ", defaultHealthPath)
	answer, err := readAnswer(in)
	switch {
	case err != nil:
		return "", err
	case answer == "":
		return defaultHealthPath, nil
	case !strings.HasPrefix(answer, "/"):
		return "/" + answer, nil
	}
	return answer, nil
}

// readAnswer reads one line of input without its surrounding space. End of
// input is an empty answer.
func readAnswer(in *bufio.Reader) (string, error) {
	line, err := in.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("init --deploy: read answer: %w", err)
	}
	return strings.TrimSpace(line), nil
}

// render returns the new file content. When appending the encoded draft to
// the original bytes yields the same document as doc, that text is used, so
// every existing byte and comment stays as it was; otherwise (a flow-style
// root, an end-of-document marker, a new file) doc is encoded as a whole.
func render(original []byte, doc, draft *yaml.Node) ([]byte, error) {
	if len(bytes.TrimSpace(original)) > 0 {
		block, err := encode(draft)
		if err != nil {
			return nil, err
		}
		var sep []byte
		if !bytes.HasSuffix(original, []byte("\n")) {
			sep = []byte("\n")
		}
		appended := slices.Concat(original, sep, block)
		var got, want any
		if yaml.Unmarshal(appended, &got) == nil && doc.Decode(&want) == nil && reflect.DeepEqual(got, want) {
			return appended, nil
		}
	}
	return encode(doc)
}

func encode(n *yaml.Node) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(n); err != nil {
		return nil, fmt.Errorf("init --deploy: encode %s: %w", configName, err)
	}
	if err := enc.Close(); err != nil {
		return nil, fmt.Errorf("init --deploy: encode %s: %w", configName, err)
	}
	return buf.Bytes(), nil
}

// validate decodes content into the config type and runs
// ValidateDeployments on it.
func validate(content []byte) error {
	var raw any
	if err := yaml.Unmarshal(content, &raw); err != nil {
		return fmt.Errorf("init --deploy: parse drafted %s: %w", configName, err)
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return fmt.Errorf("init --deploy: %s: %w", configName, err)
	}
	var cfg config.HookCIConfig
	if err := json.Unmarshal(encoded, &cfg); err != nil {
		return fmt.Errorf("init --deploy: %s: %w", configName, err)
	}
	errs := config.ValidateDeployments(&cfg)
	if len(errs) == 0 {
		return nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "init --deploy: the drafted deployment does not validate; %s left unchanged:", configName)
	for _, e := range errs {
		b.WriteString("\n  " + e.Error())
	}
	return errors.New(b.String())
}

// writeAtomic replaces path with data through a temporary file in the same
// directory, so a reader sees the old file or the new one, never a part.
func writeAtomic(path string, data []byte, mode fs.FileMode) (err error) {
	f, err := os.CreateTemp(filepath.Dir(path), configName+".*")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			f.Close()
			os.Remove(f.Name())
		}
	}()
	if _, err = f.Write(data); err != nil {
		return err
	}
	if err = f.Chmod(mode); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

func printNextSteps(out io.Writer, path, repo string) {
	env := envFile(repo)
	fmt.Fprintf(out, "wrote deployments.%s to %s\n", environment, path)
	fmt.Fprintf(out, "It deploys pushes to main after the checks pass; edit deployments.%s.on.push if your default branch differs.\n", environment)
	fmt.Fprintln(out, "Next steps on the deploy host:")
	fmt.Fprintf(out, "  1. Create %s with the app's environment, then run: chmod 600 %s\n", env, env)
	fmt.Fprintf(out, "  2. Add this line inside your site block in the Caddyfile: import %s\n", routeFile(repo))
	fmt.Fprintln(out, "  3. Run: hookci doctor")
}

func routeFile(repo string) string {
	return "/etc/caddy/routes/" + repo + "-" + environment + ".caddy"
}

func envFile(repo string) string {
	return "/etc/hookci/env/" + repo + "/" + environment + ".env"
}

// projectName is repo lowercased with every character outside [a-z0-9-]
// replaced by -.
func projectName(repo string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' {
			return r
		}
		return '-'
	}, strings.ToLower(repo))
}

func mapping(content ...*yaml.Node) *yaml.Node {
	return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Content: content}
}

func str(value string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value}
}
