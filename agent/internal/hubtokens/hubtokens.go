// Package hubtokens obtains short-lived GitHub fetch tokens from the hub: a
// token_request frame goes out and the matching token frame comes back on the
// hub session.
package hubtokens

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/redact"
)

// Timeout bounds how long Request waits for the hub's token frame.
const Timeout = 30 * time.Second

// Sender queues a frame for the hub; *hubclient.Client implements it.
type Sender interface {
	Send(ctx context.Context, f protocol.Frame) (int64, error)
}

// Broker pairs token requests with the hub's answers by run ID. It is safe
// for concurrent use.
type Broker struct {
	send      Sender
	clk       clock.Clock
	mu        sync.Mutex
	waiters   map[string][]*waiter
	refusable []*waiter // pending RequestTrigger waiters, oldest first
}

type waiter struct {
	id string
	ch chan answer
}

// answer is a token frame or the hub's refusal.
type answer struct {
	tok     protocol.Token
	refusal string
	refused bool
}

// New returns a Broker that sends through s. A nil clk is the real clock.
func New(s Sender, clk clock.Clock) *Broker {
	if clk == nil {
		clk = clock.Real{}
	}
	return &Broker{send: s, clk: clk, waiters: map[string][]*waiter{}}
}

// Request asks the hub for a fetch token for runID and waits up to Timeout
// for it. The token is registered with the redactor before it is returned.
func (b *Broker) Request(ctx context.Context, runID string) (string, error) {
	return b.request(ctx, runID, false)
}

// RequestTrigger is Request for a deploy trigger the agent has not answered
// yet, keyed by its trigger ID. Unlike Request, the hub may refuse it: see
// Refuse.
func (b *Broker) RequestTrigger(ctx context.Context, triggerID string) (string, error) {
	return b.request(ctx, triggerID, true)
}

func (b *Broker) request(ctx context.Context, id string, refusable bool) (string, error) {
	w := &waiter{id: id, ch: make(chan answer, 1)}
	b.mu.Lock()
	b.waiters[id] = append(b.waiters[id], w)
	if refusable {
		b.refusable = append(b.refusable, w)
	}
	b.mu.Unlock()
	defer b.drop(w)

	timeout := b.clk.After(Timeout)
	if _, err := b.send.Send(ctx, protocol.TokenRequest{RunId: id, Purpose: protocol.TokenRequestPurposeFetch}); err != nil {
		return "", fmt.Errorf("hubtokens: request token for %s: %w", id, err)
	}
	select {
	case a := <-w.ch:
		if a.refused {
			return "", fmt.Errorf("hubtokens: hub refused a token for %s: %s", id, a.refusal)
		}
		if a.tok.Token == "" {
			return "", fmt.Errorf("hubtokens: empty token for %s", id)
		}
		redact.AddSecret(a.tok.Token, time.Unix(int64(a.tok.Exp), 0))
		return a.tok.Token, nil
	case <-timeout:
		return "", fmt.Errorf("hubtokens: no token for %s within %s", id, Timeout)
	case <-ctx.Done():
		return "", fmt.Errorf("hubtokens: token for %s: %w", id, ctx.Err())
	}
}

// Deliver hands a token frame to every Request waiting on its run ID. A
// token nobody waits for is dropped.
func (b *Broker) Deliver(tok protocol.Token) {
	b.mu.Lock()
	ws := b.waiters[tok.RunId]
	delete(b.waiters, tok.RunId)
	b.refusable = slices.DeleteFunc(b.refusable, func(x *waiter) bool { return slices.Contains(ws, x) })
	b.mu.Unlock()
	for _, w := range ws {
		w.ch <- answer{tok: tok}
	}
}

// Refuse fails the oldest pending RequestTrigger with the hub's refusal
// message and reports whether there was one. The hub's auth_failed frame
// names no request, so a refusal that arrives while a trigger request is
// pending is charged to that request rather than to the agent credential.
func (b *Broker) Refuse(message string) bool {
	b.mu.Lock()
	if len(b.refusable) == 0 {
		b.mu.Unlock()
		return false
	}
	w := b.refusable[0]
	b.unlist(w)
	b.mu.Unlock()
	w.ch <- answer{refusal: message, refused: true}
	return true
}

func (b *Broker) drop(w *waiter) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.unlist(w)
}

// unlist removes w from the pending requests; b.mu must be held. Once
// unlisted, w gets no further answer.
func (b *Broker) unlist(w *waiter) {
	ws := slices.DeleteFunc(b.waiters[w.id], func(x *waiter) bool { return x == w })
	if len(ws) == 0 {
		delete(b.waiters, w.id)
	} else {
		b.waiters[w.id] = ws
	}
	b.refusable = slices.DeleteFunc(b.refusable, func(x *waiter) bool { return x == w })
}
