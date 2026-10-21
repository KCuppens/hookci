package logpipe

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const fixtureWorkdir = "/work/src"

// annotateOutput sends output through a Pipe annotating with parser and
// returns what it collected.
func annotateOutput(t *testing.T, parser, output string) ([]Annotation, int) {
	t.Helper()
	p, err := New(Options{RunDir: t.TempDir(), Job: "lint", Annotate: parser, Workdir: fixtureWorkdir})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Stdout().Write([]byte(output)); err != nil {
		t.Fatal(err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	return p.Annotations()
}

func readFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func checkAnnotations(t *testing.T, got, want []Annotation) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Errorf("annotations:\n got %+v\nwant %+v", got, want)
	}
}

func TestESLintStylishFixture(t *testing.T) {
	got, truncated := annotateOutput(t, "eslint", readFixture(t, "eslint_stylish.txt"))
	checkAnnotations(t, got, []Annotation{
		{Path: "app/index.js", Line: 1, Column: 10, Level: LevelFailure, Message: "'foo' is defined but never used", Title: "no-unused-vars"},
		{Path: "app/index.js", Line: 4, Column: 3, Level: LevelWarning, Message: "Unexpected console statement", Title: "no-console"},
		{Path: "lib/util.ts", Line: 12, Column: 1, Level: LevelFailure, Message: "Missing return type on function", Title: "@typescript-eslint/explicit-function-return-type"},
	})
	if truncated != 0 {
		t.Errorf("truncated = %d, want 0", truncated)
	}
}

func TestTSCFixture(t *testing.T) {
	got, _ := annotateOutput(t, "tsc", readFixture(t, "tsc.txt"))
	checkAnnotations(t, got, []Annotation{
		{Path: "src/index.ts", Line: 3, Column: 7, Level: LevelFailure, Message: "Type 'string' is not assignable to type 'number'.", Title: "TS2322"},
		{Path: "abs.ts", Line: 1, Column: 1, Level: LevelFailure, Message: "';' expected.", Title: "TS1005"},
		{Path: "src/pretty.ts", Line: 5, Column: 12, Level: LevelFailure, Message: "Argument of type 'number' is not assignable to parameter of type 'string'.", Title: "TS2345"},
		{Path: "src/plain2.ts", Line: 8, Column: 2, Level: LevelFailure, Message: "Parameter 'x' implicitly has an 'any' type.", Title: "TS7006"},
	})
}

func TestAnnotationsCapAt50(t *testing.T) {
	var out strings.Builder
	for i := 1; i <= 60; i++ {
		fmt.Fprintf(&out, "src/f.ts(%d,1): error TS2304: Cannot find name 'x'.\n", i)
	}
	got, truncated := annotateOutput(t, "tsc", out.String())
	if len(got) != MaxAnnotations || truncated != 10 {
		t.Fatalf("got %d items, truncated %d; want 50 and 10", len(got), truncated)
	}
	if got[0].Line != 1 || got[49].Line != 50 {
		t.Errorf("kept lines %d..%d, want the first 50", got[0].Line, got[49].Line)
	}
}

func TestAnnotationPathOutsideWorkdirDropped(t *testing.T) {
	got, truncated := annotateOutput(t, "tsc", "/etc/passwd(1,1): error TS1: x\n../up.ts(1,1): error TS1: x\n")
	if len(got) != 0 || truncated != 0 {
		t.Errorf("got %+v (truncated %d), want nothing", got, truncated)
	}
}
