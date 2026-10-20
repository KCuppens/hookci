package logtail

import (
	"bytes"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/redact"
)

const logFile = "r1/logs/build.log"

// harness is a Tailer over an in-memory run directory that records every
// frame it sends.
type harness struct {
	*Tailer
	fs       fstest.MapFS
	clk      *clock.Fake
	frames   []protocol.Log
	finished bool
}

func newHarness(t *testing.T, redactFn func([]byte) []byte) *harness {
	t.Helper()
	if redactFn == nil {
		redactFn = func(b []byte) []byte { return b }
	}
	h := &harness{fs: fstest.MapFS{}, clk: clock.NewFake(time.Unix(1_700_000_000, 0))}
	h.Tailer = NewTailer(t.TempDir(), redactFn, func(l protocol.Log) error {
		h.frames = append(h.frames, l)
		return nil
	})
	h.Tailer.fsys = h.fs
	h.Tailer.clk = h.clk
	h.Finished = func(runID, job string) bool { return h.finished }
	return h
}

func (h *harness) write(s string) { h.fs[logFile] = &fstest.MapFile{Data: []byte(s)} }

func (h *harness) append(s string) {
	f := h.fs[logFile]
	if f == nil {
		h.write(s)
		return
	}
	f.Data = append(f.Data, s...)
}

func decoded(t *testing.T, l protocol.Log) string {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(l.Bytes)
	if err != nil {
		t.Fatalf("frame at %d: bytes not base64: %v", l.Offset, err)
	}
	return string(b)
}

func (h *harness) text(t *testing.T) string {
	var sb strings.Builder
	for _, l := range h.frames {
		sb.WriteString(decoded(t, l))
	}
	return sb.String()
}

// lines returns n lines of exactly width bytes each, newline included.
func lines(n, width int) string {
	line := strings.Repeat("x", width-1) + "\n"
	return strings.Repeat(line, n)
}

func TestOffsetsAreOrderedAndContiguous(t *testing.T) {
	h := newHarness(t, nil)
	if err := h.Subscribe("r1", "build", 0); err != nil {
		t.Fatal(err)
	}
	h.tick() // no log file yet
	if len(h.frames) != 0 {
		t.Fatalf("frames before the log exists = %+v", h.frames)
	}
	h.write("one\n")
	h.tick()
	h.append("two\nthree\n")
	h.tick()
	h.append("partial")
	h.tick()
	h.append(" line\n")
	h.tick()

	want := "one\ntwo\nthree\npartial line\n"
	if got := h.text(t); got != want {
		t.Errorf("sent text = %q; want %q", got, want)
	}
	next := 0
	for _, l := range h.frames {
		if l.RunId != "r1" || l.Job != "build" || l.Eof {
			t.Errorf("frame = %+v; want r1/build without eof", l)
		}
		if l.Offset != next {
			t.Errorf("frame offset = %d; want %d", l.Offset, next)
		}
		next += len(decoded(t, l))
	}
	if len(h.frames) != 3 {
		t.Errorf("sent %d frames; want 3 (the partial line waits for its newline)", len(h.frames))
	}
}

func TestSubscribeFromOffset(t *testing.T) {
	h := newHarness(t, nil)
	h.write("skipped\nwanted\n")
	if err := h.Subscribe("r1", "build", int64(len("skipped\n"))); err != nil {
		t.Fatal(err)
	}
	h.tick()
	if len(h.frames) != 1 || h.frames[0].Offset != 8 || decoded(t, h.frames[0]) != "wanted\n" {
		t.Errorf("frames = %+v; want wanted\\n at 8", h.frames)
	}
}

func TestLargeLogArrivesInChunks(t *testing.T) {
	h := newHarness(t, nil)
	h.write(lines(3200, 64)) // 200 KiB
	h.finished = true
	if err := h.Subscribe("r1", "build", 0); err != nil {
		t.Fatal(err)
	}
	h.tick()

	want := []struct{ offset, size int }{{0, ChunkSize}, {ChunkSize, ChunkSize}, {2 * ChunkSize, ChunkSize}, {3 * ChunkSize, 8 << 10}}
	if len(h.frames) != len(want)+1 {
		t.Fatalf("sent %d frames; want %d chunks and eof", len(h.frames), len(want))
	}
	for i, w := range want {
		l := h.frames[i]
		if l.Offset != w.offset || len(decoded(t, l)) != w.size || l.Eof {
			t.Errorf("frame %d = offset %d, %d bytes, eof %v; want offset %d, %d bytes", i, l.Offset, len(decoded(t, l)), l.Eof, w.offset, w.size)
		}
	}
	if eof := h.frames[len(want)]; !eof.Eof || eof.Offset != 200<<10 || eof.Bytes != "" {
		t.Errorf("last frame = %+v; want empty eof at %d", eof, 200<<10)
	}
}

func TestSixthSubscriptionIsRefused(t *testing.T) {
	h := newHarness(t, nil)
	for i := range MaxSubscriptions {
		if err := h.Subscribe("r1", "job"+string(rune('a'+i)), 0); err != nil {
			t.Fatalf("subscription %d: %v", i+1, err)
		}
	}
	if err := h.Subscribe("r1", "jobf", 0); !errors.Is(err, ErrTooManySubscriptions) {
		t.Fatalf("6th Subscribe err = %v; want ErrTooManySubscriptions", err)
	}
	if err := h.Subscribe("r1", "joba", 10); err != nil {
		t.Errorf("re-subscribing a streaming job: %v", err)
	}
	h.Unsubscribe("r1", "joba")
	if err := h.Subscribe("r1", "jobf", 0); err != nil {
		t.Errorf("Subscribe after Unsubscribe: %v", err)
	}
}

func TestSubscribeRejectsPathsOutsideRunDir(t *testing.T) {
	h := newHarness(t, nil)
	for _, k := range [][2]string{{"..", "build"}, {"r1", "../../etc/passwd"}, {"r1/logs", "build"}, {"", "build"}, {"r1", ""}, {"r1", `a\b`}} {
		if err := h.Subscribe(k[0], k[1], 0); err == nil {
			t.Errorf("Subscribe(%q, %q) succeeded", k[0], k[1])
		}
	}
	if err := h.Subscribe("r1", "build", -1); err == nil {
		t.Error("Subscribe with a negative offset succeeded")
	}
}

func TestSecretSplitAcrossReadsIsRedacted(t *testing.T) {
	r, _ := redact.New([]string{"s3cr3tvalue"}, nil)
	h := newHarness(t, func(b []byte) []byte {
		var out bytes.Buffer
		w := r.Writer(&out)
		_, _ = w.Write(b)
		_ = w.Close()
		return out.Bytes()
	})
	if err := h.Subscribe("r1", "build", 0); err != nil {
		t.Fatal(err)
	}
	// Split between two polls.
	h.write("token=s3cr3t")
	h.tick()
	h.append("value\n")
	h.tick()
	// Split by the 64 KiB read size: this poll reads ChunkSize bytes from
	// the end of the first line, which ends inside the secret.
	pad := ChunkSize - 6
	h.append(lines(pad/64, 64) + strings.Repeat("y", pad%64-1) + "\n" + "s3cr3tvalue\n")
	h.tick()
	h.finished = true
	h.tick()

	for _, l := range h.frames {
		if strings.Contains(decoded(t, l), "s3cr3t") {
			t.Errorf("frame at %d leaks the secret: %q", l.Offset, decoded(t, l))
		}
	}
	got := h.text(t)
	if !strings.HasPrefix(got, "token="+redact.Mask+"\n") || !strings.HasSuffix(got, "\n"+redact.Mask+"\n") {
		t.Errorf("sent text does not mask both secrets: %q...%q", got[:20], got[len(got)-20:])
	}
	if last := h.frames[len(h.frames)-1]; !last.Eof {
		t.Errorf("last frame = %+v; want eof", last)
	}
}

func TestFinishedJobEndsWithEOF(t *testing.T) {
	h := newHarness(t, nil)
	h.write("a\nb")
	if err := h.Subscribe("r1", "build", 0); err != nil {
		t.Fatal(err)
	}
	h.tick()
	if len(h.frames) != 1 || decoded(t, h.frames[0]) != "a\n" || h.frames[0].Eof {
		t.Fatalf("frames while running = %+v; want a\\n only", h.frames)
	}
	h.finished = true
	h.tick()
	if len(h.frames) != 2 {
		t.Fatalf("sent %d frames; want 2", len(h.frames))
	}
	if last := h.frames[1]; !last.Eof || last.Offset != 2 || decoded(t, last) != "b" {
		t.Errorf("last frame = %+v; want b at 2 with eof", last)
	}
	h.append("\nmore\n")
	h.tick()
	if len(h.frames) != 2 {
		t.Errorf("frames after eof = %+v; want the subscription dropped", h.frames[2:])
	}
}

func TestFinishedJobWithoutLogEndsWithEOF(t *testing.T) {
	h := newHarness(t, nil)
	h.finished = true
	if err := h.Subscribe("r1", "build", 0); err != nil {
		t.Fatal(err)
	}
	h.tick()
	if len(h.frames) != 1 || !h.frames[0].Eof || h.frames[0].Offset != 0 {
		t.Errorf("frames = %+v; want one eof at 0", h.frames)
	}
}

func TestRateLimit(t *testing.T) {
	h := newHarness(t, nil)
	h.write(lines(16384, 64)) // 1 MiB
	if err := h.Subscribe("r1", "build", 0); err != nil {
		t.Fatal(err)
	}
	start := h.clk.Now()
	sent := func() int {
		n := 0
		for _, l := range h.frames {
			n += len(decoded(t, l))
		}
		return n
	}
	h.tick()
	if got := sent(); got != RateLimit {
		t.Errorf("first poll sent %d bytes; want the %d byte burst", got, RateLimit)
	}
	for range 6 {
		h.clk.Advance(PollInterval)
		h.tick()
		elapsed := h.clk.Now().Sub(start)
		limit := RateLimit + int(elapsed*RateLimit/time.Second)
		if got := sent(); got != limit {
			t.Errorf("after %s sent %d bytes; want %d (256 KiB/s after the burst)", elapsed, got, limit)
		}
	}
	if got := sent(); got != 1<<20 {
		t.Errorf("after 3s sent %d bytes; want the whole 1 MiB", got)
	}
}

func TestSendFailureDropsSubscription(t *testing.T) {
	h := newHarness(t, nil)
	calls := 0
	h.send = func(protocol.Log) error { calls++; return errors.New("not connected") }
	h.write("a\n")
	if err := h.Subscribe("r1", "build", 0); err != nil {
		t.Fatal(err)
	}
	h.tick()
	h.append("b\n")
	h.tick()
	if calls != 1 {
		t.Errorf("send called %d times; want 1, then the subscription dropped", calls)
	}
}

func TestUnsubscribeAllStopsStreams(t *testing.T) {
	h := newHarness(t, nil)
	h.write("a\n")
	if err := h.Subscribe("r1", "build", 0); err != nil {
		t.Fatal(err)
	}
	h.UnsubscribeAll()
	h.tick()
	if len(h.frames) != 0 {
		t.Errorf("frames after UnsubscribeAll = %+v", h.frames)
	}
}

func TestReadsJobLogFromRunDir(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "r1", "logs", "build.log")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("on disk\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var frames []protocol.Log
	tl := NewTailer(dir, func(b []byte) []byte { return b }, func(l protocol.Log) error {
		frames = append(frames, l)
		return nil
	})
	if err := tl.Subscribe("r1", "build", 0); err != nil {
		t.Fatal(err)
	}
	tl.tick()
	if len(frames) != 1 || frames[0].Bytes != base64.StdEncoding.EncodeToString([]byte("on disk\n")) {
		t.Errorf("frames = %+v; want on disk\\n", frames)
	}
}
