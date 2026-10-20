package logpipe

import (
	"regexp"
	"strconv"
	"strings"
)

// Level is an annotation severity; the values match protocol annotation
// levels.
type Level string

const (
	LevelNotice  Level = "notice"
	LevelWarning Level = "warning"
	LevelFailure Level = "failure"
)

// Annotation is one file diagnostic found in job output. It mirrors
// protocol.AnnotationsItemsElem.
type Annotation struct {
	Path    string
	Line    int
	Column  int // 0 when unknown
	Level   Level
	Message string
	Title   string // rule id for eslint, "TSxxxx" for tsc
}

// Parser turns output lines into annotations. Feed gets every redacted line
// of a job in order; Path in the result is as printed by the tool.
type Parser interface {
	Feed(line string) (Annotation, bool)
}

// ParserFor returns the parser for a job's `annotate:` value ("eslint" or
// "tsc"), or nil for "" and unknown names.
func ParserFor(name string) Parser {
	switch name {
	case "eslint":
		return &ESLintStylish{}
	case "tsc":
		return TSC{}
	}
	return nil
}

var ansi = regexp.MustCompile(`\x1b\[[0-9;]*m`)

func stripANSI(s string) string {
	if !strings.Contains(s, "\x1b") {
		return s
	}
	return ansi.ReplaceAllString(s, "")
}

func levelOf(s string) Level {
	if s == "error" {
		return LevelFailure
	}
	return LevelWarning
}

// ESLintStylish parses ESLint's default `stylish` formatter: a file path line
// followed by indented `line:col  level  message  rule` lines. A blank line
// ends the file's block.
type ESLintStylish struct {
	file string
}

var eslintProblem = regexp.MustCompile(`^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)$`)

// Feed implements Parser.
func (p *ESLintStylish) Feed(line string) (Annotation, bool) {
	line = strings.TrimRight(stripANSI(line), " \t")
	switch {
	case line == "":
		p.file = ""
		return Annotation{}, false
	case line[0] != ' ' && line[0] != '\t':
		if !strings.HasSuffix(line, ":") {
			p.file = line
		}
		return Annotation{}, false
	case p.file == "":
		return Annotation{}, false
	}
	m := eslintProblem.FindStringSubmatch(line)
	if m == nil {
		return Annotation{}, false
	}
	ln, _ := strconv.Atoi(m[1])
	col, _ := strconv.Atoi(m[2])
	return Annotation{Path: p.file, Line: ln, Column: col, Level: levelOf(m[3]), Message: m[4], Title: m[5]}, true
}

// TSC parses the TypeScript compiler's plain `file(line,col): error TSn: msg`
// and pretty `file:line:col - error TSn: msg` diagnostics.
type TSC struct{}

var (
	tscPlain  = regexp.MustCompile(`^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$`)
	tscPretty = regexp.MustCompile(`^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.+)$`)
)

// Feed implements Parser.
func (TSC) Feed(line string) (Annotation, bool) {
	line = stripANSI(line)
	m := tscPlain.FindStringSubmatch(line)
	if m == nil {
		if m = tscPretty.FindStringSubmatch(line); m == nil {
			return Annotation{}, false
		}
	}
	ln, _ := strconv.Atoi(m[2])
	col, _ := strconv.Atoi(m[3])
	return Annotation{Path: m[1], Line: ln, Column: col, Level: levelOf(m[4]), Message: m[6], Title: m[5]}, true
}
