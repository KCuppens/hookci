package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"net"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
	"gopkg.in/yaml.v3"
)

const schemaURL = "https://ci.webuno.io/schema/zeroci.schema.json"

// Config is a parsed .zeroci.yml: the generated root type plus the resolved
// view of the checks that Parse builds once the file is valid.
type Config struct {
	ZeroCIConfig `yaml:",inline"`

	checks *ResolvedChecks
}

// Checks returns the checks with defaults applied, job limits merged and jobs
// in dependency order. It is nil for a Config that did not come from Parse.
func (c *Config) Checks() *ResolvedChecks {
	return c.checks
}

// ParseOptions configures Parse and Load.
type ParseOptions struct {
	// SelfHosted allows trust: all when the file has no deployments.
	SelfHosted bool
	// FS is where deployment env_file paths are looked up. Nil means
	// os.DirFS("/").
	FS fs.StatFS
	// Stat, when set, replaces FS for the env_file owner and mode checks.
	// The path passed in is absolute.
	Stat func(name string) (fs.FileInfo, error)
}

// Load reads and parses the configuration file at path. The error is only
// for I/O failures; problems in the file come back as Diagnostics.
func Load(path string, opts ParseOptions) (*Config, Diagnostics, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	cfg, diags := Parse(data, opts)
	return cfg, diags, nil
}

// Parse decodes, schema-validates and semantically checks a configuration.
// The returned Config is nil when the diagnostics contain an error; warnings
// alone leave it usable.
func Parse(data []byte, opts ParseOptions) (*Config, Diagnostics) {
	raw, lines, diags := decodeYAML(data)
	if diags.HasErrors() {
		diags.sort()
		return nil, diags
	}
	return build(raw, lines, opts)
}

// FromRoot builds a Config from a generated root value through the same
// schema, semantic and resolve steps as Parse, so a configuration built in
// code (auto-detection) is indistinguishable from a parsed file. Diagnostics
// carry paths but no lines.
func FromRoot(root ZeroCIConfig) (*Config, Diagnostics) {
	encoded, err := json.Marshal(root)
	if err != nil {
		return nil, Diagnostics{{Message: fmt.Sprintf("cannot encode configuration: %v", err), Severity: SeverityError}}
	}
	raw, err := jsonschema.UnmarshalJSON(bytes.NewReader(encoded))
	if err != nil {
		return nil, Diagnostics{{Message: fmt.Sprintf("cannot encode configuration: %v", err), Severity: SeverityError}}
	}
	return build(raw, lineIndex{}, ParseOptions{})
}

// build validates a decoded document and turns it into a Config with its
// resolved checks.
func build(raw any, lines lineIndex, opts ParseOptions) (*Config, Diagnostics) {
	if diags := validateSchema(raw, lines); diags.HasErrors() {
		diags.sort()
		return nil, diags
	}

	var cfg Config
	encoded, err := json.Marshal(raw)
	if err == nil {
		err = json.Unmarshal(encoded, &cfg.ZeroCIConfig)
	}
	if err != nil {
		return nil, Diagnostics{{Message: fmt.Sprintf("cannot decode configuration: %v", err), Severity: SeverityError}}
	}

	diags := checkSemantics(&cfg.ZeroCIConfig, opts, lines)
	diags.sort()
	if diags.HasErrors() {
		return nil, diags
	}
	cfg.checks = resolveChecks(&cfg.ZeroCIConfig, raw)
	return &cfg, diags
}

// Limits on what one document may expand to, so alias cycles and alias
// bombs fail with a diagnostic instead of exhausting the stack or memory.
const (
	maxYAMLDepth  = 100
	maxYAMLValues = 100_000
)

var yamlLineRe = regexp.MustCompile(`^yaml: line (\d+): (.*)$`)

// decodeYAML parses data into plain maps, slices and scalars, recording the
// line of every key and sequence item. Duplicate and non-string keys are
// errors; anchors, aliases and merge keys are expanded.
func decodeYAML(data []byte) (any, lineIndex, Diagnostics) {
	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		d := Diagnostic{Message: "invalid YAML: " + strings.TrimPrefix(err.Error(), "yaml: "), Severity: SeverityError}
		if m := yamlLineRe.FindStringSubmatch(err.Error()); m != nil {
			d.Line, _ = strconv.Atoi(m[1])
			d.Message = "invalid YAML: " + m[2]
			d.Fix = "check the indentation and quoting on this line"
		}
		return nil, nil, Diagnostics{d}
	}
	if len(doc.Content) == 0 {
		return nil, nil, Diagnostics{{Message: "the file is empty", Fix: "start the file with version: 1", Severity: SeverityError}}
	}

	root := doc.Content[0]
	dec := &yamlDecoder{lines: lineIndex{"": root.Line}}
	raw := dec.value(root, "")
	return raw, dec.lines, dec.diags
}

type yamlDecoder struct {
	lines    lineIndex
	diags    Diagnostics
	depth    int
	values   int
	exceeded bool
	reported map[string]bool
}

func (d *yamlDecoder) report(diag Diagnostic) {
	key := strconv.Itoa(diag.Line) + "\x00" + diag.Message
	if d.reported[key] {
		return
	}
	if d.reported == nil {
		d.reported = map[string]bool{}
	}
	d.reported[key] = true
	d.diags = append(d.diags, diag)
}

func (d *yamlDecoder) setLine(path string, line int) {
	if _, ok := d.lines[path]; !ok {
		d.lines[path] = line
	}
}

func (d *yamlDecoder) value(n *yaml.Node, path string) any {
	if d.exceeded {
		return nil
	}
	d.values++
	if d.depth >= maxYAMLDepth || d.values > maxYAMLValues {
		d.exceeded = true
		d.report(d.lines.errorf(path, "remove recursive or deeply nested aliases",
			"the document nests or expands too deeply (more than %d levels or %d values)", maxYAMLDepth, maxYAMLValues))
		return nil
	}
	d.depth++
	defer func() { d.depth-- }()

	switch n.Kind {
	case yaml.AliasNode:
		return d.value(n.Alias, path)
	case yaml.SequenceNode:
		out := make([]any, 0, len(n.Content))
		for i, item := range n.Content {
			p := joinIndex(path, i)
			d.setLine(p, item.Line)
			out = append(out, d.value(item, p))
		}
		return out
	case yaml.MappingNode:
		return d.mapping(n, path)
	default:
		return scalarValue(n)
	}
}

func (d *yamlDecoder) mapping(n *yaml.Node, path string) map[string]any {
	out := make(map[string]any, len(n.Content)/2)
	firstLine := make(map[string]int, len(n.Content)/2)
	var merges []*yaml.Node
	for i := 0; i+1 < len(n.Content); i += 2 {
		k, v := n.Content[i], n.Content[i+1]
		if k.Kind == yaml.ScalarNode && k.ShortTag() == "!!merge" {
			merges = append(merges, v)
			continue
		}
		key, ok := d.key(k, path)
		if !ok {
			continue
		}
		p := joinKey(path, key)
		if first, dup := firstLine[key]; dup {
			d.report(Diagnostic{Path: p, Line: k.Line, Severity: SeverityError,
				Message: fmt.Sprintf("duplicate key %s, first defined on line %d", quote(key), first),
				Fix:     "remove one of the two entries"})
			continue
		}
		firstLine[key] = k.Line
		d.setLine(p, k.Line)
		out[key] = d.value(v, p)
	}
	for _, m := range merges {
		d.merge(m, path, out)
	}
	return out
}

// merge applies a "<<" merge key: keys already in out (explicit, or from an
// earlier merge source) win.
func (d *yamlDecoder) merge(src *yaml.Node, path string, out map[string]any) {
	for src.Kind == yaml.AliasNode {
		src = src.Alias
	}
	var sources []*yaml.Node
	switch src.Kind {
	case yaml.MappingNode:
		sources = []*yaml.Node{src}
	case yaml.SequenceNode:
		for _, s := range src.Content {
			for s.Kind == yaml.AliasNode {
				s = s.Alias
			}
			sources = append(sources, s)
		}
	}
	for _, s := range sources {
		if s.Kind != yaml.MappingNode {
			d.report(Diagnostic{Path: path, Line: src.Line, Severity: SeverityError,
				Message: "a << merge value must be a mapping or a list of mappings",
				Fix:     "merge an anchored mapping, for example <<: *defaults"})
			return
		}
		merged, ok := d.value(s, path).(map[string]any)
		if !ok {
			return
		}
		for k, v := range merged {
			if _, exists := out[k]; !exists {
				out[k] = v
			}
		}
	}
}

func (d *yamlDecoder) key(k *yaml.Node, path string) (string, bool) {
	for k.Kind == yaml.AliasNode {
		k = k.Alias
	}
	if k.Kind != yaml.ScalarNode {
		d.report(Diagnostic{Path: path, Line: k.Line, Severity: SeverityError,
			Message: "keys must be plain strings, not mappings or lists",
			Fix:     "use a plain word as the key"})
		return "", false
	}
	if k.ShortTag() != "!!str" {
		d.report(Diagnostic{Path: path, Line: k.Line, Severity: SeverityError,
			Message: fmt.Sprintf("key %s is not a string", quote(k.Value)),
			Fix:     fmt.Sprintf("quote the key: %s:", quote(k.Value))})
		return "", false
	}
	return k.Value, true
}

// scalarValue converts a scalar to the JSON-like value the schema validator
// expects. Timestamps and custom tags stay strings; NaN and infinities stay
// strings so the schema reports them instead of the number checks.
func scalarValue(n *yaml.Node) any {
	switch n.ShortTag() {
	case "!!null":
		return nil
	case "!!bool", "!!int", "!!float":
		var v any
		if err := n.Decode(&v); err != nil {
			return n.Value
		}
		if f, ok := v.(float64); ok && (math.IsNaN(f) || math.IsInf(f, 0)) {
			return n.Value
		}
		return v
	default:
		return n.Value
	}
}

var compiledSchema = sync.OnceValue(func() *jsonschema.Schema {
	doc, err := jsonschema.UnmarshalJSON(strings.NewReader(string(SchemaJSON)))
	if err != nil {
		panic(fmt.Sprintf("config: embedded schema is not JSON: %v", err))
	}
	c := jsonschema.NewCompiler()
	if err := c.AddResource(schemaURL, doc); err != nil {
		panic(fmt.Sprintf("config: embedded schema: %v", err))
	}
	return c.MustCompile(schemaURL)
})

// schemaDoc is the embedded schema as plain JSON, used to list the allowed
// keys when suggesting a fix for an unknown key.
var schemaDoc = sync.OnceValue(func() map[string]any {
	var doc map[string]any
	if err := json.Unmarshal(SchemaJSON, &doc); err != nil {
		panic(fmt.Sprintf("config: embedded schema is not JSON: %v", err))
	}
	return doc
})

// validateSchema validates raw against the embedded schema and turns every
// failing leaf into a Diagnostic.
func validateSchema(raw any, li lineIndex) Diagnostics {
	err := compiledSchema().Validate(raw)
	if err == nil {
		return nil
	}
	var verr *jsonschema.ValidationError
	if !errors.As(err, &verr) {
		return Diagnostics{{Message: fmt.Sprintf("cannot validate configuration: %v", err), Severity: SeverityError}}
	}
	var diags Diagnostics
	seen := map[string]bool{}
	var walk func(e, parent *jsonschema.ValidationError)
	walk = func(e, parent *jsonschema.ValidationError) {
		_, names := e.ErrorKind.(*kind.PropertyNames)
		if !names && len(e.Causes) > 0 {
			for _, c := range e.Causes {
				walk(c, e)
			}
			return
		}
		loc := e.InstanceLocation
		if names && parent != nil {
			// jsonschema v6.0.3 gives propertyNames errors a location slice
			// that later validation overwrites. The enclosing error belongs to
			// the same object and holds a copy taken before that happens.
			loc = parent.InstanceLocation
		}
		for _, d := range schemaDiagnostics(e, instancePath(raw, loc), li) {
			key := d.Path + "\x00" + d.Message
			if !seen[key] {
				seen[key] = true
				diags = append(diags, d)
			}
		}
	}
	walk(verr, nil)
	return diags
}

// instancePath renders a JSON pointer as a dotted path, using [i] for
// sequence indexes.
func instancePath(raw any, tokens []string) string {
	path, cur := "", raw
	for _, tok := range tokens {
		switch v := cur.(type) {
		case []any:
			i, _ := strconv.Atoi(tok)
			path = joinIndex(path, i)
			cur = nil
			if i >= 0 && i < len(v) {
				cur = v[i]
			}
		case map[string]any:
			path = joinKey(path, tok)
			cur = v[tok]
		default:
			path = joinKey(path, tok)
			cur = nil
		}
	}
	return path
}

// schemaDiagnostics words one schema failure at path. Messages are written
// here rather than taken from the validator so they stay short and ASCII.
func schemaDiagnostics(e *jsonschema.ValidationError, path string, li lineIndex) Diagnostics {
	switch k := e.ErrorKind.(type) {
	case *kind.AdditionalProperties:
		props := append([]string(nil), k.Properties...)
		sort.Strings(props)
		allowed := allowedKeys(e.SchemaURL)
		out := make(Diagnostics, 0, len(props))
		for _, p := range props {
			out = append(out, li.errorf(joinKey(path, p), unknownKeyFix(p, allowed), "unknown key %s", quote(p)))
		}
		return out
	case *kind.Required:
		out := make(Diagnostics, 0, len(k.Missing))
		for _, m := range k.Missing {
			fix := "add " + m + ": <value>"
			if path == "" && m == "version" {
				fix = "add version: 1 at the top of the file"
			}
			out = append(out, li.errorf(path, fix, "missing required key %s", quote(m)))
		}
		return out
	case *kind.PropertyNames:
		return Diagnostics{nameDiagnostic(path, k.Property, li)}
	case *kind.Const:
		if path == "version" {
			return Diagnostics{li.errorf(path, "set version: 1", "unsupported version %s; this zeroci reads version 1", jsonText(k.Got))}
		}
		return Diagnostics{li.errorf(path, "", "must be %s, got %s", jsonText(k.Want), jsonText(k.Got))}
	case *kind.Enum:
		want := make([]string, len(k.Want))
		for i, w := range k.Want {
			want[i] = jsonText(w)
		}
		fix := ""
		if got, ok := k.Got.(string); ok {
			names := make([]string, 0, len(k.Want))
			for _, w := range k.Want {
				if s, ok := w.(string); ok {
					names = append(names, s)
				}
			}
			if best := closest(got, names); best != "" {
				fix = "did you mean " + quote(best) + "?"
			}
		}
		return Diagnostics{li.errorf(path, fix, "must be one of %s, got %s", strings.Join(want, ", "), jsonText(k.Got))}
	case *kind.Type:
		want := make([]string, len(k.Want))
		for i, w := range k.Want {
			want[i] = typeName(w)
		}
		return Diagnostics{li.errorf(path, "", "must be %s, got %s", strings.Join(want, " or "), typeName(k.Got))}
	case *kind.Pattern:
		msg, fix := patternProblem(path, k.Got, k.Want)
		return Diagnostics{li.errorf(path, fix, "%s", msg)}
	case *kind.MinProperties:
		fix := ""
		if path == "checks.jobs" {
			fix = "define at least one job, for example unit: {run: make test}"
		}
		return Diagnostics{li.errorf(path, fix, "must have at least %d %s", k.Want, plural(k.Want, "entry", "entries"))}
	case *kind.MaxProperties:
		return Diagnostics{li.errorf(path, "", "has %d entries; at most %d are allowed", k.Got, k.Want)}
	case *kind.MinItems:
		return Diagnostics{li.errorf(path, "", "must have at least %d %s", k.Want, plural(k.Want, "item", "items"))}
	case *kind.MaxItems:
		return Diagnostics{li.errorf(path, "remove entries", "has %d items; at most %d are allowed", k.Got, k.Want)}
	case *kind.UniqueItems:
		return Diagnostics{li.errorf(joinIndex(path, k.Duplicates[1]), "remove the duplicate",
			"duplicate of item %d", k.Duplicates[0])}
	case *kind.MinLength:
		if k.Want == 1 {
			return Diagnostics{li.errorf(path, "", "must not be empty")}
		}
		return Diagnostics{li.errorf(path, "", "must be at least %d characters", k.Want)}
	case *kind.MaxLength:
		return Diagnostics{li.errorf(path, "", "must be at most %d characters, got %d", k.Want, k.Got)}
	case *kind.Minimum:
		return Diagnostics{li.errorf(path, "", "must be at least %s, got %s", k.Want.RatString(), k.Got.RatString())}
	case *kind.Maximum:
		return Diagnostics{li.errorf(path, "", "must be at most %s, got %s", k.Want.RatString(), k.Got.RatString())}
	case *kind.ExclusiveMinimum:
		return Diagnostics{li.errorf(path, "", "must be greater than %s, got %s", k.Want.RatString(), k.Got.RatString())}
	case *kind.ExclusiveMaximum:
		return Diagnostics{li.errorf(path, "", "must be less than %s, got %s", k.Want.RatString(), k.Got.RatString())}
	case *kind.FalseSchema:
		return Diagnostics{li.errorf(path, "remove it", "is not allowed here")}
	default:
		return Diagnostics{li.errorf(path, "", "fails the schema rule %s", strings.Join(e.ErrorKind.KeywordPath(), "/"))}
	}
}

func nameDiagnostic(parent, name string, li lineIndex) Diagnostic {
	path := joinKey(parent, name)
	switch parent {
	case "checks.jobs":
		return li.errorf(path, "rename it using lowercase letters, digits, - and _",
			"invalid job name %s: job names start with a lowercase letter or digit and are at most 63 characters of a-z, 0-9, - and _", quote(name))
	case "deployments":
		return li.errorf(path, "rename it using lowercase letters, digits and -",
			"invalid environment name %s: environment names start with a lowercase letter and are at most 32 characters of a-z, 0-9 and -", quote(name))
	default:
		return li.errorf(path, "rename it", "invalid name %s", quote(name))
	}
}

var egressPathRe = regexp.MustCompile(`^checks\.egress\[[0-9]+\]$`)

// patternProblem explains a failed pattern. Egress entries, env_file, memory
// and durations get specific wording; anything else names the pattern.
func patternProblem(path, got, want string) (msg, fix string) {
	switch {
	case egressPathRe.MatchString(path):
		return egressProblem(got)
	case strings.HasPrefix(path, "deployments.") && strings.HasSuffix(path, ".env_file"):
		return fmt.Sprintf("env_file %s must be an absolute path", quote(got)), "use a path that starts with /, for example /etc/zeroci/production.env"
	case strings.HasSuffix(path, ".memory"):
		return fmt.Sprintf("%s is not a memory size", quote(got)), "use a number with a K, M or G suffix, for example 4G or 512M"
	case strings.HasSuffix(path, ".timeout"):
		return fmt.Sprintf("%s is not a duration", quote(got)), "use a whole number with an s, m or h suffix, for example 90s, 10m or 1h"
	default:
		return fmt.Sprintf("%s does not match the pattern %s", quote(got), want), ""
	}
}

// egressProblem explains why a checks.egress entry fails the schema pattern.
// The pattern admits only exact lowercase host names, the one form the egress
// proxy's allow-list (egress.NewAllowList) accepts; it proxies port 443 only.
func egressProblem(entry string) (msg, fix string) {
	switch {
	case entry == "":
		return "an empty entry is not a host name", "remove it"
	case entry == "*":
		return "a bare * would allow every host", "list each exact host name the jobs need"
	case strings.Contains(entry, "*"):
		example := "api.example.com"
		if domain, ok := strings.CutPrefix(entry, "*."); ok && !strings.Contains(domain, "*") {
			example = "api." + strings.ToLower(domain)
		}
		return fmt.Sprintf("wildcard %s is not allowed; list each exact host name", quote(entry)),
			"list every host the jobs reach by its full name, for example " + quote(example)
	case strings.Contains(entry, "://"):
		_, rest, _ := strings.Cut(entry, "://")
		return fmt.Sprintf("%s has a scheme; egress takes host names", quote(entry)), egressHostFix(rest)
	case strings.Contains(entry, "/"):
		return fmt.Sprintf("%s has a path; egress takes host names", quote(entry)), egressHostFix(entry)
	}
	host, port := splitHostPort(entry)
	if net.ParseIP(host) != nil {
		return fmt.Sprintf("IP literal %s is not allowed; egress takes host names", quote(entry)),
			"use the host name instead; the egress proxy resolves names itself"
	}
	if port != "" {
		return fmt.Sprintf("%s has a port; egress takes host names and only port 443 is proxied", quote(entry)),
			"use " + quote(strings.ToLower(host))
	}
	if lower := strings.ToLower(entry); lower != entry {
		return fmt.Sprintf("%s must be lowercase", quote(entry)), "use " + quote(lower)
	}
	if i := strings.IndexFunc(entry, func(r rune) bool {
		return (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '.' && r != '-'
	}); i >= 0 {
		r, _ := utf8.DecodeRuneInString(entry[i:])
		return fmt.Sprintf("%s has %s; host names use only a-z, 0-9, . and -", quote(entry), quote(string(r))),
			"use a host name such as registry.npmjs.org"
	}
	return fmt.Sprintf("%s is not a host name", quote(entry)),
		"use a host name such as registry.npmjs.org; each dot-separated label starts and ends with a letter or digit, and the last starts with a letter"
}

// egressHostFix suggests the host inside an entry that carries a scheme or
// path: everything before the first / with any port removed.
func egressHostFix(s string) string {
	s, _, _ = strings.Cut(s, "/")
	if host, _ := splitHostPort(s); host != "" {
		return "use " + quote(strings.ToLower(host))
	}
	return "use a host name such as registry.npmjs.org"
}

// splitHostPort splits host:port, accepting bracketed and bare IPv6.
func splitHostPort(s string) (host, port string) {
	if strings.HasPrefix(s, "[") {
		if end := strings.IndexByte(s, ']'); end > 0 {
			return s[1:end], strings.TrimPrefix(s[end+1:], ":")
		}
	}
	if strings.Count(s, ":") == 1 {
		host, port, _ = strings.Cut(s, ":")
		return host, port
	}
	return s, ""
}

func unknownKeyFix(key string, allowed []string) string {
	if best := closest(key, allowed); best != "" {
		return "did you mean " + quote(best) + "?"
	}
	if len(allowed) > 0 {
		return "remove it; allowed keys are " + strings.Join(allowed, ", ")
	}
	return "remove it"
}

// allowedKeys lists the properties of the schema object at schemaLoc, the
// location reported with an additionalProperties failure.
func allowedKeys(schemaLoc string) []string {
	_, frag, _ := strings.Cut(schemaLoc, "#")
	frag = strings.TrimSuffix(frag, "/additionalProperties")
	var node any = schemaDoc()
	for _, tok := range strings.Split(strings.TrimPrefix(frag, "/"), "/") {
		if tok == "" {
			continue
		}
		tok = strings.ReplaceAll(strings.ReplaceAll(tok, "~1", "/"), "~0", "~")
		m, ok := node.(map[string]any)
		if !ok {
			return nil
		}
		node = m[tok]
	}
	m, _ := node.(map[string]any)
	props, _ := m["properties"].(map[string]any)
	keys := make([]string, 0, len(props))
	for k := range props {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// closest returns the candidate within edit distance 2 of s (and closer than
// s is long), or "" when none is close.
func closest(s string, candidates []string) string {
	best, bestDist := "", 3
	for _, c := range candidates {
		if d := editDistance(s, c); d < bestDist && d < len(s) {
			best, bestDist = c, d
		}
	}
	return best
}

func editDistance(a, b string) int {
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(b)]
}

func typeName(t string) string {
	switch t {
	case "object":
		return "a mapping"
	case "array":
		return "a list"
	case "string":
		return "a string"
	case "integer":
		return "an integer"
	case "number":
		return "a number"
	case "boolean":
		return "true or false"
	default:
		return t
	}
}

// jsonText renders a schema value compactly with ASCII-only escapes.
func jsonText(v any) string {
	if s, ok := v.(string); ok {
		return quote(s)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}
