// Package hubtokens obtains short-lived GitHub fetch tokens from the hub: a
// token_request frame goes out and the matching token frame comes back on the
// hub session.
package hubtokens

import (
	"context"
	"errors"
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

// ErrRefused is wrapped by the Request error when the hub refused the token,
// as it does for a run or trigger it no longer holds open.
var ErrRefused = errors.New("hubtokens: hub refused a token")

// Sender queues a frame for the hub and withdraws one nobody waits for any
// more; *hubclient.Client implements it.
type Sender interface {
	Send(ctx context.Context, f protocol.Frame) (int64, error)
	Withdraw(ctx context.Context, seq int64) error
}

// Broker pairs token requests with the hub's answers by run ID. It is safe
// for concurrent use.
type Broker struct {
	send    Sender
	clk     clock.Clock
	mu      sync.Mutex
	waiters map[string][]*waiter
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

// Request asks the hub for a fetch token for id, a run or deploy trigger
// ID, and waits up to Timeout for it. The token is registered with the
// redactor before it is returned. A request that gets no answer is withdrawn
// from the outbox, so a reconnect does not replay it.
func (b *Broker) Request(ctx context.Context, id string) (string, error) {
	w := &waiter{id: id, ch: make(chan answer, 1)}
	b.mu.Lock()
	b.waiters[id] = append(b.waiters[id], w)
	b.mu.Unlock()
	defer b.drop(w)

	timeout := b.clk.After(Timeout)
	seq, err := b.send.Send(ctx, protocol.TokenRequest{RunId: id, Purpose: protocol.TokenRequestPurposeFetch})
	if err != nil {
		return "", fmt.Errorf("hubtokens: request token for %s: %w", id, err)
	}
	select {
	case a := <-w.ch:
		if a.refused {
			return "", fmt.Errorf("%w for %s: %s", ErrRefused, id, a.refusal)
		}
		if a.tok.Token == "" {
			return "", fmt.Errorf("hubtokens: empty token for %s", id)
		}
		redact.AddSecret(a.tok.Token, time.Unix(int64(a.tok.Exp), 0))
		return a.tok.Token, nil
	case <-timeout:
		return "", b.withdraw(ctx, seq, fmt.Errorf("hubtokens: no token for %s within %s", id, Timeout))
	case <-ctx.Done():
		return "", b.withdraw(ctx, seq, fmt.Errorf("hubtokens: token for %s: %w", id, ctx.Err()))
	}
}

// withdraw drops the unanswered request seq from the outbox and returns
// cause, joined with any withdraw failure.
func (b *Broker) withdraw(ctx context.Context, seq int64, cause error) error {
	if err := b.send.Withdraw(context.WithoutCancel(ctx), seq); err != nil {
		return errors.Join(cause, fmt.Errorf("hubtokens: withdraw token request: %w", err))
	}
	return cause
}

// Deliver hands a token frame to every Request waiting on its run ID. A
// token nobody waits for is dropped.
func (b *Broker) Deliver(tok protocol.Token) {
	b.mu.Lock()
	ws := b.waiters[tok.RunId]
	delete(b.waiters, tok.RunId)
	b.mu.Unlock()
	for _, w := range ws {
		w.ch <- answer{tok: tok}
	}
}

// Refuse fails every Request waiting on runID with the hub's refusal
// message and reports whether there was one.
func (b *Broker) Refuse(runID, message string) bool {
	b.mu.Lock()
	ws := b.waiters[runID]
	delete(b.waiters, runID)
	b.mu.Unlock()
	for _, w := range ws {
		w.ch <- answer{refusal: message, refused: true}
	}
	return len(ws) > 0
}

// drop removes w from the pending requests. Once dropped, w gets no
// further answer.
func (b *Broker) drop(w *waiter) {
	b.mu.Lock()
	defer b.mu.Unlock()
	ws := slices.DeleteFunc(b.waiters[w.id], func(x *waiter) bool { return x == w })
	if len(ws) == 0 {
		delete(b.waiters, w.id)
	} else {
		b.waiters[w.id] = ws
	}
}
