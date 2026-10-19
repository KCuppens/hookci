// Command zeroci is the ZeroCI deployment agent.
package main

import (
	"os"

	"github.com/KCuppens/zerocideploy/agent/internal/cli"
)

func main() { os.Exit(cli.Main(os.Args[1:], os.Stdout, os.Stderr)) }
