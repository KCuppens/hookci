// Command zeroci is the ZeroCI deployment agent.
package main

import (
	"os"
	"strings"

	"github.com/KCuppens/zerocideploy/agent/internal/askpass"
	"github.com/KCuppens/zerocideploy/agent/internal/cli"
)

func main() {
	// git runs this binary as GIT_ASKPASS during a hub checkout (see source.HubSource).
	if os.Getenv(askpass.EnvSock) != "" && looksLikeAskpass(os.Args) {
		os.Exit(askpass.Main(os.Args, os.Stdout))
	}
	os.Exit(cli.Main(os.Args[1:], os.Stdout, os.Stderr))
}

// looksLikeAskpass reports whether args is a git credential prompt rather
// than a CLI command line.
func looksLikeAskpass(args []string) bool {
	return len(args) == 2 && (strings.HasPrefix(args[1], "Username") || strings.HasPrefix(args[1], "Password"))
}
