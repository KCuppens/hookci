// Package askpass serves git fetch credentials over a unix socket. The agent
// runs Serve for one checkout and points git at its own binary as
// GIT_ASKPASS; git then runs that binary, which calls Main to read the token
// from the socket. The token never touches disk, argv or the environment.
package askpass

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"time"
)

// EnvSock names the variable holding the socket path. Its presence makes the
// hookci binary answer a git prompt instead of running the CLI.
const EnvSock = "HOOKCI_ASKPASS_SOCK"

// User is the username GitHub expects with an installation token.
const User = "x-access-token"

// dialTimeout bounds the whole exchange with the agent, which may be waiting
// on the hub for the token.
const dialTimeout = 45 * time.Second

// maxToken bounds how much Main reads from the socket.
const maxToken = 64 << 10

// Serve listens on sockPath (mode 0600) and answers each connection with one
// line holding token(ctx). A token error closes the connection without
// writing, so git fails the fetch. stop closes the listener, waits for open
// connections and removes the socket; it is safe to call twice.
func Serve(ctx context.Context, sockPath string, token func(ctx context.Context) (string, error)) (stop func(), err error) {
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		return nil, fmt.Errorf("askpass: listen: %w", err)
	}
	if err := os.Chmod(sockPath, 0o600); err != nil {
		ln.Close()
		os.Remove(sockPath)
		return nil, fmt.Errorf("askpass: chmod socket: %w", err)
	}
	ctx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	wg.Go(func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			wg.Go(func() { answer(ctx, c, token) })
		}
	})
	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			ln.Close()
			wg.Wait()
			os.Remove(sockPath)
		})
	}, nil
}

func answer(ctx context.Context, c net.Conn, token func(ctx context.Context) (string, error)) {
	defer c.Close()
	tok, err := token(ctx)
	if err != nil || tok == "" || strings.ContainsAny(tok, "\r\n") {
		return
	}
	_ = c.SetWriteDeadline(time.Now().Add(dialTimeout))
	_, _ = io.WriteString(c, tok+"\n")
}

// Main answers the git prompt in args[1]: "Username..." prints User and
// "Password..." prints the token read from $HOOKCI_ASKPASS_SOCK. Any other
// prompt or a socket failure exits 1 with nothing on stdout.
func Main(args []string, stdout io.Writer) int {
	if len(args) != 2 {
		fmt.Fprintln(os.Stderr, "hookci askpass: want exactly one prompt argument")
		return 1
	}
	switch prompt := args[1]; {
	case strings.HasPrefix(prompt, "Username"):
		fmt.Fprintln(stdout, User)
		return 0
	case strings.HasPrefix(prompt, "Password"):
		tok, err := fetch(os.Getenv(EnvSock))
		if err != nil {
			fmt.Fprintf(os.Stderr, "hookci askpass: %v\n", err)
			return 1
		}
		fmt.Fprintln(stdout, tok)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "hookci askpass: unexpected prompt %q\n", prompt)
		return 1
	}
}

func fetch(sock string) (string, error) {
	if sock == "" {
		return "", errors.New(EnvSock + " is not set")
	}
	c, err := net.DialTimeout("unix", sock, dialTimeout)
	if err != nil {
		return "", err
	}
	defer c.Close()
	if err := c.SetDeadline(time.Now().Add(dialTimeout)); err != nil {
		return "", err
	}
	line, err := bufio.NewReader(io.LimitReader(c, maxToken)).ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("read token: %w", err)
	}
	tok := strings.TrimSuffix(line, "\n")
	if tok == "" {
		return "", errors.New("empty token")
	}
	return tok, nil
}
