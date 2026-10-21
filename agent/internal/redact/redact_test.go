package redact

import (
	"bytes"
	"regexp"
	"strings"
	"testing"
)

// Fake secrets are assembled at runtime so secret scanners do not flag the
// source file.
func fake(prefix string, n int) string { return prefix + strings.Repeat("A1b2", n/4+1)[:n] }

func TestBuiltinsRedact(t *testing.T) {
	r, _ := New(nil, nil)
	cases := []struct{ name, secret string }{
		{"ghs", fake("ghs_", 36)},
		{"ghp", fake("ghp_", 36)},
		{"github_pat", fake("github_pat_", 40)},
		{"xoxb", fake("xoxb-", 24)},
		{"akia", "AKIA" + strings.Repeat("Z7", 8)},
		{"aws_secret", "aws_secret_access_key = " + fake("abc", 37)},
		{"jwt", "eyJ" + fake("", 12) + ".eyJ" + fake("", 16) + "." + fake("", 20)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := r.Line("token: " + c.secret + " end")
			if !strings.Contains(got, Mask) || strings.Contains(got, c.secret) {
				t.Errorf("Line = %q, want %s and no secret", got, Mask)
			}
		})
	}
}

func TestLiteralRedactionLongestFirst(t *testing.T) {
	r, warnings := New([]string{"abcd", "abcdefgh"}, nil)
	if len(warnings) != 0 {
		t.Errorf("warnings = %v", warnings)
	}
	if got := r.Line("x abcdefgh y"); got != "x *** y" {
		t.Errorf("Line = %q, want %q", got, "x *** y")
	}
}

func TestShortLiteralSkippedWithWarning(t *testing.T) {
	r, warnings := New([]string{"abc"}, nil)
	if got := r.Line("x abc y"); got != "x abc y" {
		t.Errorf("Line = %q, want short literal left alone", got)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "length 3") {
		t.Errorf("warnings = %q, want one warning naming length 3", warnings)
	}
	if strings.Contains(warnings[0], "abc") {
		t.Errorf("warning %q leaks the value", warnings[0])
	}
}

func TestConfigPatterns(t *testing.T) {
	r, _ := New(nil, []*regexp.Regexp{regexp.MustCompile(`internal-[0-9]+`)})
	if got := r.Line("host internal-42 up"); got != "host *** up" {
		t.Errorf("Line = %q, want %q", got, "host *** up")
	}
}

func TestWriterSplitAcrossWrites(t *testing.T) {
	r, _ := New([]string{"s3cr3t-value"}, nil)
	var out bytes.Buffer
	w := r.Writer(&out)
	for _, chunk := range []string{"login s3cr", "3t-value ok\r\nlast s3cr3t", "-value"} {
		if _, err := w.Write([]byte(chunk)); err != nil {
			t.Fatal(err)
		}
	}
	if got := out.String(); got != "login *** ok\r\n" {
		t.Errorf("before Close = %q, want the partial line held back", got)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "login *** ok\r\nlast ***"; got != want {
		t.Errorf("after Close = %q, want %q", got, want)
	}
	if _, err := w.Write([]byte("x\n")); err == nil {
		t.Error("Write after Close succeeded")
	}
}

type chunkRecorder struct{ chunks [][]byte }

func (c *chunkRecorder) Write(p []byte) (int, error) {
	c.chunks = append(c.chunks, bytes.Clone(p))
	return len(p), nil
}

func TestWriterLongLine(t *testing.T) {
	r, _ := New(nil, nil)
	rec := &chunkRecorder{}
	w := r.Writer(rec)
	line := bytes.Repeat([]byte("x"), 200<<10)
	for i := 0; i < len(line); i += 3000 {
		if _, err := w.Write(line[i:min(i+3000, len(line))]); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if len(rec.chunks) < 4 {
		t.Fatalf("got %d chunks, want the line split into at least 4", len(rec.chunks))
	}
	total := 0
	for i, c := range rec.chunks {
		if len(c) > 64<<10 {
			t.Errorf("chunk %d is %d bytes, over 64 KiB", i, len(c))
		}
		total += len(c)
	}
	if total != len(line) {
		t.Errorf("emitted %d bytes, want %d", total, len(line))
	}
}
