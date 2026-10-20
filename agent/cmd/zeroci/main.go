// Command zeroci is the ZeroCI deployment agent.
package main

import (
	"os"

	"github.com/KCuppens/zerocideploy/agent/internal/cli"
	"github.com/KCuppens/zerocideploy/agent/internal/source"
)

func main() {
	// git runs this binary as GIT_ASKPASS with ZEROCI_ASKPASS=1 (see source.AskpassEnv).
	if os.Getenv("ZEROCI_ASKPASS") == "1" {
		os.Exit(source.RunAskpass(os.Args[1:], os.Stdout, os.Stderr))
	}
	os.Exit(cli.Main(os.Args[1:], os.Stdout, os.Stderr))
}
