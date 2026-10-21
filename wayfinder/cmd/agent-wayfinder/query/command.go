package query

import (
	"io"

	cmd "agent-wayfinder/cmd/agent-wayfinder/internal/command"

	"github.com/spf13/cobra"
)

func New(standardOutput, standardError io.Writer, exitCode *int) *cobra.Command {
	return cmd.NewLeaf("query", "Execute a direct constrained graph query", Configure, runDirect, standardOutput, standardError, exitCode)
}

func Configure(command *cobra.Command) {
	cmd.DatabaseAndFormatFlags(command)
	command.Flags().String("query", "", "constrained graph-query source")
	command.Flags().String("file", "", "file containing constrained graph-query source")
	command.Flags().String("path", ".", "workspace path")
	command.Flags().Int("max-depth", 2, "maximum traversal depth")
	command.Flags().Int("max-nodes", 100, "maximum traversed nodes")
	command.Flags().Bool("diagnostics", false, "include generated SQL and parameters")
}
