// Command zeroci is the ZeroCI deployment agent.
package main

import (
	"context"
	"os"

	"github.com/KCuppens/zerocideploy/agent/internal/cli"
)

func main() {
	os.Exit(cli.Main(context.Background(), os.Args[1:], os.Stdout, os.Stderr))
}
