// Package hubtokens obtains short-lived GitHub fetch tokens from the hub: a
// token_request frame goes out and the matching token frame comes back on the
// hub session.
package hubtokens

import (
	"context"
	"fmt"
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
	send    Sender
	clk     clock.Clock
	mu      sync.Mutex
	waiters map[string][]chan protocol.Token
}

// New returns a Broker that sends through s. A nil clk is the real clock.
func New(s Sender, clk clock.Clock) *Broker {
	if clk == nil {
		clk = clock.Real{}
	}
	return &Broker{send: s, clk: clk, waiters: map[string][]chan protocol.Token{}}
}

// Request asks the hub for a fetch token for runID and waits up to Timeout
// for it. The token is registered with the redactor before it is returned.
func (b *Broker) Request(ctx context.Context, runID string) (string, error) {
	ch := make(chan protocol.Token, 1)
	b.mu.Lock()
	b.waiters[runID] = append(b.waiters[runID], ch)
	b.mu.Unlock()
	defer b.drop(runID, ch)

	timeout := b.clk.After(Timeout)
	if _, err := b.send.Send(ctx, protocol.TokenRequest{RunId: runID, Purpose: protocol.TokenRequestPurposeFetch}); err != nil {
		return "", fmt.Errorf("hubtokens: request token for %s: %w", runID, err)
	}
	select {
	case tok := <-ch:
		if tok.Token == "" {
			return "", fmt.Errorf("hubtokens: empty token for %s", runID)
		}
		redact.AddSecret(tok.Token, time.Unix(int64(tok.Exp), 0))
		return tok.Token, nil
	case <-timeout:
		return "", fmt.Errorf("hubtokens: no token for %s within %s", runID, Timeout)
	case <-ctx.Done():
		return "", fmt.Errorf("hubtokens: token for %s: %w", runID, ctx.Err())
	}
}

// Deliver hands a token frame to every Request waiting on its run ID. A
// token nobody waits for is dropped.
func (b *Broker) Deliver(tok protocol.Token) {
	b.mu.Lock()
	ws := b.waiters[tok.RunId]
	delete(b.waiters, tok.RunId)
	b.mu.Unlock()
	for _, ch := range ws {
		ch <- tok
	}
}

func (b *Broker) drop(runID string, ch chan protocol.Token) {
	b.mu.Lock()
	defer b.mu.Unlock()
	ws := b.waiters[runID]
	for i, w := range ws {
		if w == ch {
			ws = append(ws[:i], ws[i+1:]...)
			break
		}
	}
	if len(ws) == 0 {
		delete(b.waiters, runID)
	} else {
		b.waiters[runID] = ws
	}
}
