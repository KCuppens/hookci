package redact

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
)

// EnvEntry is one KEY=VALUE line of a dotenv file.
type EnvEntry struct {
	Key, Value string
}

// ParseEnv reads a dotenv stream: `KEY=VALUE` lines, blank lines, `#`
// comment lines, an optional `export ` prefix, and values optionally wrapped
// in matching single or double quotes. bad holds the 1-based numbers of the
// lines that are not KEY=VALUE: no '=', or an empty key.
func ParseEnv(r io.Reader) (entries []EnvEntry, bad []int, err error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		key, value, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			bad = append(bad, n)
			continue
		}
		entries = append(entries, EnvEntry{Key: key, Value: unquote(strings.TrimSpace(value))})
	}
	if err := sc.Err(); err != nil {
		return nil, nil, err
	}
	return entries, bad, nil
}

// LoadEnvFileValues reads a dotenv file as ParseEnv does and returns its
// values for redaction. Keys are never returned. Empty values are skipped.
// Values shorter than MinSecretLen are skipped with a warning that names the
// key, never the value. Lines that are not KEY=VALUE are skipped with a
// warning that names the line number.
func LoadEnvFileValues(path string) (values []string, warnings []string, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()

	entries, bad, err := ParseEnv(f)
	if err != nil {
		return nil, nil, fmt.Errorf("redact: read %s: %w", path, err)
	}
	for _, e := range entries {
		switch {
		case e.Value == "":
			continue
		case len(e.Value) < MinSecretLen:
			warnings = append(warnings, fmt.Sprintf("redact: skipping value of length %d from %s key %s", len(e.Value), path, e.Key))
			continue
		}
		values = append(values, e.Value)
	}
	for _, n := range bad {
		warnings = append(warnings, fmt.Sprintf("redact: %s:%d: not KEY=VALUE, skipped", path, n))
	}
	return values, warnings, nil
}

func unquote(v string) string {
	if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
		return v[1 : len(v)-1]
	}
	return v
}
