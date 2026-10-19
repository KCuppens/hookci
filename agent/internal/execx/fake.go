package execx

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// FakeResponse describes how a Fake should respond to a matched command.
type FakeResponse struct {
	Stdout string
	Stderr string
	Code   int
	Err    error
	Fn     func(c Cmd) error
}

type fakeMatcher struct {
	name       string
	argsPrefix []string
	resp       FakeResponse
}

// Fake is a Runner that records every call and replies according to
// registered matchers. Safe for concurrent use.
type Fake struct {
	mu       sync.Mutex
	Calls    []Cmd
	matchers []fakeMatcher
}

// On registers a response for the first call whose Name equals name and
// whose Args begin with argsPrefix.
func (f *Fake) On(name string, argsPrefix []string, resp FakeResponse) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.matchers = append(f.matchers, fakeMatcher{name: name, argsPrefix: argsPrefix, resp: resp})
}

// Called reports whether a command matching name and argsPrefix was
// recorded.
func (f *Fake) Called(name string, argsPrefix ...string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.Calls {
		if c.Name == name && hasPrefix(c.Args, argsPrefix) {
			return true
		}
	}
	return false
}

// Run records c and replies with the first matching registered response.
func (f *Fake) Run(_ context.Context, c Cmd) error {
	f.mu.Lock()
	f.Calls = append(f.Calls, c)

	var matched *fakeMatcher
	for i := range f.matchers {
		m := &f.matchers[i]
		if m.name == c.Name && hasPrefix(c.Args, m.argsPrefix) {
			matched = m
			break
		}
	}
	f.mu.Unlock()

	if matched == nil {
		return fmt.Errorf("execx fake: unexpected command %s %s", c.Name, strings.Join(c.Args, " "))
	}

	resp := matched.resp
	if resp.Stdout != "" && c.Stdout != nil {
		_, _ = c.Stdout.Write([]byte(resp.Stdout))
	}
	if resp.Stderr != "" && c.Stderr != nil {
		_, _ = c.Stderr.Write([]byte(resp.Stderr))
	}
	if resp.Fn != nil {
		if err := resp.Fn(c); err != nil {
			return err
		}
	}
	if resp.Err != nil {
		return resp.Err
	}
	if resp.Code != 0 {
		return &ExitError{Code: resp.Code, Stderr: resp.Stderr}
	}
	return nil
}

// hasPrefix reports whether args begins with prefix.
func hasPrefix(args, prefix []string) bool {
	if len(prefix) > len(args) {
		return false
	}
	for i := range prefix {
		if args[i] != prefix[i] {
			return false
		}
	}
	return true
}
