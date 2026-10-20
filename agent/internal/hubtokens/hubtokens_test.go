package hubtokens

import (
	"context"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/redact"
)

type sender chan protocol.Frame

func (s sender) Send(_ context.Context, f protocol.Frame) (int64, error) {
	s <- f
	return 1, nil
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

// TestBrokerRefuse: a hub refusal fails the oldest pending trigger request
// and never a run request, which keeps waiting for its token.
func TestBrokerRefuse(t *testing.T) {
	sent := make(sender, 4)
	b := New(sent, clock.NewFake(time.Unix(1_700_000_000, 0)))
	if b.Refuse("run not bound") {
		t.Fatal("Refuse with nothing pending = true, want false")
	}
	exp := int(time.Now().Add(time.Hour).Unix())

	run := request(b, "run-1")
	<-sent
	if b.Refuse("run not bound") {
		t.Fatal("Refuse with only a run request pending = true, want false")
	}
	first := start(b.RequestTrigger, "trg-1")
	<-sent
	second := start(b.RequestTrigger, "trg-2")
	<-sent

	if !b.Refuse("run not bound") {
		t.Fatal("Refuse with trigger requests pending = false, want true")
	}
	if r := <-first; r[0] != "" || r[1] == nil || r[1].(error).Error() != "hubtokens: hub refused a token for trg-1: run not bound" {
		t.Fatalf("first trigger request = %q, %v; want refused", r[0], r[1])
	}
	b.Deliver(protocol.Token{RunId: "trg-2", Token: "tok-trigger-5e1c", Exp: exp})
	if r := <-second; r[0] != "tok-trigger-5e1c" || r[1] != nil {
		t.Fatalf("second trigger request = %q, %v; want its token", r[0], r[1])
	}
	if b.Refuse("run not bound") {
		t.Fatal("Refuse after every trigger request was answered = true, want false")
	}
	b.Deliver(protocol.Token{RunId: "run-1", Token: "tok-run-77ad", Exp: exp})
	if r := <-run; r[0] != "tok-run-77ad" || r[1] != nil {
		t.Fatalf("run request = %q, %v; want its token", r[0], r[1])
	}
}

func TestBrokerTimeout(t *testing.T) {
	clk := clock.NewFake(time.Unix(1_700_000_000, 0))
	sent := make(sender, 2)
	b := New(sent, clk)

	done := request(b, "run-1")
	if f := <-sent; f != (protocol.TokenRequest{RunId: "run-1", Purpose: protocol.TokenRequestPurposeFetch}) {
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

	const tok = "tok-delivered-9f3a"
	done = request(b, "run-2")
	<-sent
	b.Deliver(protocol.Token{RunId: "run-2", Token: tok, Exp: int(time.Now().Add(time.Hour).Unix())})
	if r := <-done; r[0] != tok || r[1] != nil {
		t.Fatalf("Request = %q, %v; want the delivered token", r[0], r[1])
	}
	red, _ := redact.New(nil, nil)
	if got := red.Line("x " + tok); got != "x "+redact.Mask {
		t.Fatalf("redactor line = %q, want the token masked", got)
	}
}
