// Package logtail streams the live log of a running job to the hub's log
// viewer. The hub subscribes to a job from a byte offset; the Tailer polls
// the job's log file and sends what it grows by, redacted and rate limited,
// until the job has ended and every byte was sent.
package logtail

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/KCuppens/hookci/agent/internal/clock"
	"github.com/KCuppens/hookci/agent/internal/logpipe"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/redact"
)

const (
	// ChunkSize is the most log bytes one read takes, and so one frame carries.
	ChunkSize = 64 << 10
	// PollInterval is how often subscribed log files are checked for growth.
	PollInterval = 500 * time.Millisecond
	// MaxSubscriptions is how many jobs the agent streams at once.
	MaxSubscriptions = 5
	// RateLimit is the most log bytes per second the agent streams, across
	// every subscription. It is also the burst.
	RateLimit = 256 << 10
)

// ErrTooManySubscriptions means MaxSubscriptions jobs are streaming already.
var ErrTooManySubscriptions = errors.New("logtail: too many log subscriptions")

// Tailer streams subscribed job logs. Subscribe and Unsubscribe are safe to
// call from any goroutine; reading and sending happen on Run's.
type Tailer struct {
	// Finished reports whether a job has ended, so its log file is
	// complete. Set it before Run; nil treats every job as running.
	Finished func(runID, job string) bool

	redact func([]byte) []byte
	send   func(protocol.Log) error
	fsys   fs.FS
	clk    clock.Clock
	wake   chan struct{}

	mu   sync.Mutex
	subs map[key]*subscription

	// Token bucket, owned by Run's goroutine.
	tokens int64
	filled time.Time
}

type key struct{ runID, job string }

// subscription is one streamed job log. Its fields are owned by Run's
// goroutine; Unsubscribe only removes it from Tailer.subs.
type subscription struct {
	key
	name  string // file name in Tailer.fsys
	next  int64  // file offset of the next read
	start int64  // file offset of carry
	carry []byte // read but not sent: a partial line
}

// NewTailer returns a Tailer over the run directories in logDir
// (<state>/runs), whose job logs are <runID>/logs/<job>.log. redact masks
// each chunk before send gets it; it must redact the way log upload does.
func NewTailer(logDir string, redact func([]byte) []byte, send func(protocol.Log) error) *Tailer {
	return &Tailer{
		redact: redact,
		send:   send,
		fsys:   os.DirFS(logDir),
		clk:    clock.Real{},
		wake:   make(chan struct{}, 1),
		subs:   map[key]*subscription{},
		tokens: RateLimit,
	}
}

// Subscribe starts streaming job's log of runID from offset. Subscribing to
// a job already streaming restarts it from offset.
func (t *Tailer) Subscribe(runID, job string, offset int64) error {
	name, err := logName(runID, job)
	if err != nil {
		return err
	}
	if offset < 0 {
		return fmt.Errorf("logtail: negative offset %d", offset)
	}
	k := key{runID, job}
	t.mu.Lock()
	if _, ok := t.subs[k]; !ok && len(t.subs) >= MaxSubscriptions {
		t.mu.Unlock()
		return ErrTooManySubscriptions
	}
	t.subs[k] = &subscription{key: k, name: name, next: offset, start: offset}
	t.mu.Unlock()
	select {
	case t.wake <- struct{}{}:
	default:
	}
	return nil
}

// Unsubscribe stops streaming job's log of runID.
func (t *Tailer) Unsubscribe(runID, job string) {
	t.mu.Lock()
	delete(t.subs, key{runID, job})
	t.mu.Unlock()
}

// UnsubscribeAll stops every stream, as when the hub session they were
// opened on ends.
func (t *Tailer) UnsubscribeAll() {
	t.mu.Lock()
	clear(t.subs)
	t.mu.Unlock()
}

// Run polls the subscribed logs every PollInterval, and at once after a
// Subscribe, until ctx ends.
func (t *Tailer) Run(ctx context.Context) {
	ticker := t.clk.NewTicker(PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C():
		case <-t.wake:
		}
		t.tick()
	}
}

// logName is job's log file of runID in Tailer.fsys. Both names must be one
// path element, so a subscription cannot read outside the run directories.
func logName(runID, job string) (string, error) {
	for _, s := range []string{runID, job} {
		if s == "" || s == "." || s == ".." || strings.ContainsAny(s, `/\`) {
			return "", fmt.Errorf("logtail: invalid log name %q/%q", runID, job)
		}
	}
	name := filepath.ToSlash(logpipe.LogPath(runID, job))
	if !fs.ValidPath(name) {
		return "", fmt.Errorf("logtail: invalid log name %q/%q", runID, job)
	}
	return name, nil
}

// tick refills the token bucket and reads every subscription round-robin,
// one chunk each per round, until the tokens or the new bytes run out.
func (t *Tailer) tick() {
	t.refill()
	t.mu.Lock()
	subs := make([]*subscription, 0, len(t.subs))
	for _, s := range t.subs {
		subs = append(subs, s)
	}
	t.mu.Unlock()
	slices.SortFunc(subs, func(a, b *subscription) int {
		return strings.Compare(a.runID+"\x00"+a.job, b.runID+"\x00"+b.job)
	})
	for len(subs) > 0 {
		more := subs[:0]
		for _, s := range subs {
			if t.step(s) {
				more = append(more, s)
			}
		}
		subs = more
	}
}

func (t *Tailer) refill() {
	now := t.clk.Now()
	if t.filled.IsZero() {
		t.filled = now
		return
	}
	elapsed := now.Sub(t.filled)
	if elapsed <= 0 {
		return
	}
	t.filled = now
	if elapsed >= time.Second {
		t.tokens = RateLimit
		return
	}
	t.tokens = min(RateLimit, t.tokens+int64(elapsed)*RateLimit/int64(time.Second))
}

// step reads and sends one chunk of s and reports whether s may have more
// to send right away. A job that has ended and is fully sent gets a final
// frame with eof and is dropped.
func (t *Tailer) step(s *subscription) bool {
	if !t.current(s) || t.tokens <= 0 {
		return false
	}
	buf := make([]byte, min(ChunkSize, t.tokens))
	n, err := t.read(s, buf)
	if n == 0 && err == nil && t.Finished != nil && t.Finished(s.runID, s.job) {
		// Read again: bytes written before the job ended may have landed
		// between the first read and the Finished check.
		n, err = t.read(s, buf)
		if n == 0 && err == nil {
			t.finish(s)
			return false
		}
	}
	if err != nil {
		// A log that cannot be read will not get readable: end the stream
		// as if the job had ended.
		t.finish(s)
		return false
	}
	if n == 0 {
		return false
	}
	t.tokens -= int64(n)
	s.next += int64(n)
	data := append(s.carry, buf[:n]...)
	cut := bytes.LastIndexByte(data, '\n') + 1
	if cut == 0 && len(data) > redact.MaxLine {
		// redact.Writer flushes a line this long in pieces of at most MaxLine.
		cut = redact.MaxLine
	}
	s.carry = slices.Clone(data[cut:])
	if cut > 0 {
		if !t.emit(s, data[:cut], false) {
			return false
		}
		s.start += int64(cut)
	}
	return true
}

// read reads s's log at s.next into buf. A log file that does not exist yet
// reads as empty.
func (t *Tailer) read(s *subscription, buf []byte) (int, error) {
	f, err := t.fsys.Open(s.name)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	defer f.Close()
	ra, ok := f.(io.ReaderAt)
	if !ok {
		return 0, fmt.Errorf("logtail: %s: file does not support ReadAt", s.name)
	}
	n, err := ra.ReadAt(buf, s.next)
	if errors.Is(err, io.EOF) {
		err = nil
	}
	return n, err
}

// finish sends what s still holds with eof and drops it.
func (t *Tailer) finish(s *subscription) {
	if t.emit(s, s.carry, true) {
		t.drop(s)
	}
}

// emit sends raw, redacted, at s.start. A send that fails drops s: the
// session it was subscribed on is gone. It reports whether s is still
// subscribed.
func (t *Tailer) emit(s *subscription, raw []byte, eof bool) bool {
	if !t.current(s) {
		return false
	}
	var masked []byte
	if len(raw) > 0 {
		masked = t.redact(raw)
	}
	err := t.send(protocol.Log{
		RunId:  s.runID,
		Job:    s.job,
		Offset: int(s.start),
		Bytes:  base64.StdEncoding.EncodeToString(masked),
		Eof:    eof,
	})
	if err != nil {
		t.drop(s)
		return false
	}
	return true
}

// current reports whether s is still the subscription of its job.
func (t *Tailer) current(s *subscription) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.subs[s.key] == s
}

// drop removes s unless a newer Subscribe replaced it.
func (t *Tailer) drop(s *subscription) {
	t.mu.Lock()
	if t.subs[s.key] == s {
		delete(t.subs, s.key)
	}
	t.mu.Unlock()
}
