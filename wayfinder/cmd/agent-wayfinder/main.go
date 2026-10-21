package main

import (
	"io"
	"os"

	"agent-wayfinder/cmd/agent-wayfinder/internal/root"

	"github.com/spf13/cobra"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func newRootCommand(standardOutput, standardError io.Writer) (*cobra.Command, *int) {
	return root.New(standardOutput, standardError)
}

func run(arguments []string, standardOutput, standardError io.Writer) int {
	return root.Run(arguments, standardOutput, standardError)
}
