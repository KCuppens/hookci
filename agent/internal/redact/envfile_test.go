package redact

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestLoadEnvFileValues(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.env")
	content := `# database
DATABASE_URL=postgres://u:pw@db/app
export API_TOKEN=tok-123456
  # indented comment
QUOTED="hello world"
SINGLE='it is #not a comment'
EMPTY=
EMPTY_QUOTED=""
PIN=x9z
garbage line

SPACED = spaced-value
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	values, warnings, err := LoadEnvFileValues(path)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"postgres://u:pw@db/app", "tok-123456", "hello world", "it is #not a comment", "spaced-value"}
	if !slices.Equal(values, want) {
		t.Errorf("values = %q, want %q", values, want)
	}
	for _, v := range values {
		for _, key := range []string{"DATABASE_URL", "API_TOKEN", "QUOTED", "SINGLE", "SPACED", "export"} {
			if strings.Contains(v, key) {
				t.Errorf("value %q contains key %q", v, key)
			}
		}
	}
	if len(warnings) != 2 {
		t.Fatalf("warnings = %q, want 2 (short PIN, line without '=')", warnings)
	}
	if !strings.Contains(warnings[0], "PIN") || !strings.Contains(warnings[0], "length 3") || strings.Contains(warnings[0], "x9z") {
		t.Errorf("short-value warning = %q, want key PIN and length 3 without the value", warnings[0])
	}
	if !strings.Contains(warnings[1], ":10:") {
		t.Errorf("no-'=' warning = %q, want line 10", warnings[1])
	}

	if _, _, err := LoadEnvFileValues(filepath.Join(t.TempDir(), "missing.env")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("missing file err = %v, want os.ErrNotExist", err)
	}
}

func TestParseEnv(t *testing.T) {
	entries, bad, err := ParseEnv(strings.NewReader("export A=1\n=nokey\nB='two #x'\nnoeq\n# c\nC=\"3\"\n"))
	if err != nil {
		t.Fatal(err)
	}
	want := []EnvEntry{{"A", "1"}, {"B", "two #x"}, {"C", "3"}}
	if !slices.Equal(entries, want) {
		t.Errorf("entries = %q, want %q", entries, want)
	}
	if !slices.Equal(bad, []int{2, 4}) {
		t.Errorf("bad = %v, want [2 4]", bad)
	}
}
