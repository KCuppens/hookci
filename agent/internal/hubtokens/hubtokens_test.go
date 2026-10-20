package hubtokens

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/redact"
)

// sender hands each sent frame to frames, numbering them 1, 2, ... as the
// outbox does, and records withdrawn seqs.
type sender struct {
	frames    chan protocol.Frame
	mu        sync.Mutex
	seq       int64
	withdrawn []int64
}

func newSender(n int) *sender { return &sender{frames: make(chan protocol.Frame, n)} }

func (s *sender) Send(_ context.Context, f protocol.Frame) (int64, error) {
	s.mu.Lock()
	s.seq++
	seq := s.seq
	s.mu.Unlock()
	s.frames <- f
	return seq, nil
}

func (s *sender) Withdraw(_ context.Context, seq int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.withdrawn = append(s.withdrawn, seq)
	return nil
}

func (s *sender) withdrawnSeqs() []int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.withdrawn)
}

func request(b *Broker, runID string) <-chan [2]any {
	return start(b.Request, runID)
}

func start(req func(context.Context, string) (string, error), id string) <-chan [2]any {
	done := make(chan [2]any, 1)
	go func() {
		tok, err := req(context.Background(), id)
		done <- [2]any{tok, err}
	}()
	return done
}

// TestBrokerRefuse: a hub refusal fails only the requests for the run or
// trigger it names; other requests keep waiting for their tokens.
func TestBrokerRefuse(t *testing.T) {
	sent := newSender(4)
	b := New(sent, clock.NewFake(time.Unix(1_700_000_000, 0)))
	if b.Refuse("run-1", "run not bound") {
		t.Fatal("Refuse with nothing pending = true, want false")
	}
	exp := int(time.Now().Add(time.Hour).Unix())

	run := request(b, "run-1")
	<-sent.frames
	trg := request(b, "trg-1")
	<-sent.frames

	if b.Refuse("trg-2", "run not bound") {
		t.Fatal("Refuse of an id nobody waits on = true, want false")
	}
	if !b.Refuse("run-1", "run not bound") {
		t.Fatal("Refuse of a pending run request = false, want true")
	}
	if r := <-run; r[0] != "" || r[1] == nil || r[1].(error).Error() != "hubtokens: hub refused a token for run-1: run not bound" ||
		!errors.Is(r[1].(error), ErrRefused) {
		t.Fatalf("run request = %q, %v; want refused with ErrRefused", r[0], r[1])
	}
	b.Deliver(protocol.Token{RunId: "trg-1", Token: "tok-trigger-5e1c", Exp: exp})
	if r := <-trg; r[0] != "tok-trigger-5e1c" || r[1] != nil {
		t.Fatalf("trigger request = %q, %v; want its token", r[0], r[1])
	}
	if w := sent.withdrawnSeqs(); len(w) != 0 {
		t.Errorf("withdrawn = %v, want none: both requests were answered", w)
	}
}

func TestBrokerTimeout(t *testing.T) {
	clk := clock.NewFake(time.Unix(1_700_000_000, 0))
	sent := newSender(2)
	b := New(sent, clk)

	done := request(b, "run-1")
	if f := <-sent.frames; f != (protocol.TokenRequest{RunId: "run-1", Purpose: protocol.TokenRequestPurposeFetch}) {
		t.Fatalf("sent %#v, want a fetch token_request for run-1", f)
	}
	clk.Advance(Timeout - time.Second)
	b.Deliver(protocol.Token{RunId: "other-run", Token: "tok-not-mine-1234", Exp: 1})
	select {
	case r := <-done:
		t.Fatalf("Request returned %v before the timeout", r)
	default:
	}
	clk.Advance(time.Second)
	if r := <-done; r[0] != "" || r[1] == nil {
		t.Fatalf("Request = %q, %v; want a timeout error", r[0], r[1])
	}
	if w := sent.withdrawnSeqs(); !slices.Equal(w, []int64{1}) {
		t.Fatalf("withdrawn = %v, want [1]: a timed-out request must not replay after a reconnect", w)
	}

	const tok = "tok-delivered-9f3a"
	done = request(b, "run-2")
	<-sent.frames
	b.Deliver(protocol.Token{RunId: "run-2", Token: tok, Exp: int(time.Now().Add(time.Hour).Unix())})
	if r := <-done; r[0] != tok || r[1] != nil {
		t.Fatalf("Request = %q, %v; want the delivered token", r[0], r[1])
	}
	red, _ := redact.New(nil, nil)
	if got := red.Line("x " + tok); got != "x "+redact.Mask {
		t.Fatalf("redactor line = %q, want the token masked", got)
	}
	if w := sent.withdrawnSeqs(); !slices.Equal(w, []int64{1}) {
		t.Errorf("withdrawn = %v, want only [1]: the answered request stays", w)
	}
}

func TestBrokerCancelWithdraws(t *testing.T) {
	sent := newSender(1)
	b := New(sent, clock.NewFake(time.Unix(1_700_000_000, 0)))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := b.Request(ctx, "run-1")
		done <- err
	}()
	<-sent.frames
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Request error = %v, want context.Canceled", err)
	}
	if w := sent.withdrawnSeqs(); !slices.Equal(w, []int64{1}) {
		t.Errorf("withdrawn = %v, want [1]", w)
	}
}
