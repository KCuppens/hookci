package redact

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// LoadEnvFileValues reads a dotenv file (`KEY=VALUE` lines, `#` comment
// lines, optional `export ` prefix, optional matching single or double quotes
// around the value) and returns its values for redaction. Keys are never
// returned. Empty values are skipped. Values shorter than MinSecretLen are
// skipped with a warning that names the key, never the value. Lines without
// '=' are skipped with a warning that names the line number.
func LoadEnvFileValues(path string) (values []string, warnings []string, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			warnings = append(warnings, fmt.Sprintf("redact: %s:%d: no '=' in line, skipped", path, n))
			continue
		}
		key = strings.TrimSpace(key)
		value = unquote(strings.TrimSpace(value))
		switch {
		case value == "":
			continue
		case len(value) < MinSecretLen:
			warnings = append(warnings, fmt.Sprintf("redact: skipping value of length %d from %s key %s", len(value), path, key))
			continue
		}
		values = append(values, value)
	}
	if err := sc.Err(); err != nil {
		return nil, nil, fmt.Errorf("redact: read %s: %w", path, err)
	}
	return values, warnings, nil
}

func unquote(v string) string {
	if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
		return v[1 : len(v)-1]
	}
	return v
}
