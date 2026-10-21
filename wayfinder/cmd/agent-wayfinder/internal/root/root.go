package root

import (
	"io"

	"agent-wayfinder/cli"
	"agent-wayfinder/cmd/agent-wayfinder/ask"
	"agent-wayfinder/cmd/agent-wayfinder/benchmark"
	"agent-wayfinder/cmd/agent-wayfinder/catalog"
	"agent-wayfinder/cmd/agent-wayfinder/explain"
	"agent-wayfinder/cmd/agent-wayfinder/export"
	"agent-wayfinder/cmd/agent-wayfinder/index"
	"agent-wayfinder/cmd/agent-wayfinder/indexer"
	cmd "agent-wayfinder/cmd/agent-wayfinder/internal/command"
	"agent-wayfinder/cmd/agent-wayfinder/mcp"
	"agent-wayfinder/cmd/agent-wayfinder/path"
	"agent-wayfinder/cmd/agent-wayfinder/planner_metrics"
	"agent-wayfinder/cmd/agent-wayfinder/query"
	"agent-wayfinder/cmd/agent-wayfinder/skill"

	"github.com/spf13/cobra"
)

func New(standardOutput, standardError io.Writer) (*cobra.Command, *int) {
	exitCode := 0
	root := &cobra.Command{
		Use:           "agent-wayfinder",
		Short:         "Index and query a local code graph",
		SilenceErrors: true,
		SilenceUsage:  true,
	}
	root.SetOut(standardOutput)
	root.SetErr(standardError)

	root.AddCommand(benchmark.New(standardOutput, standardError, &exitCode))
	root.AddCommand(skill.New(standardOutput, standardError, &exitCode))
	root.AddCommand(index.New(standardOutput, standardError, &exitCode))
	root.AddCommand(catalog.New(standardOutput, standardError, &exitCode))
	root.AddCommand(catalog.NewStatus(standardOutput, standardError, &exitCode))
	root.AddCommand(catalog.NewStop(standardOutput, standardError, &exitCode))
	root.AddCommand(mcp.New(standardOutput, standardError, &exitCode))
	root.AddCommand(planner_metrics.NewCopilot(standardOutput, standardError, &exitCode))
	root.AddCommand(planner_metrics.NewClaude(standardOutput, standardError, &exitCode))
	root.AddCommand(ask.New(standardOutput, standardError, &exitCode))
	root.AddCommand(query.New(standardOutput, standardError, &exitCode))
	root.AddCommand(indexer.New(standardOutput, standardError, &exitCode))
	root.AddCommand(export.New(standardOutput, standardError, &exitCode))
	root.AddCommand(explain.New(standardOutput, standardError, &exitCode))
	root.AddCommand(path.New(standardOutput, standardError, &exitCode))

	return root, &exitCode
}

func Run(arguments []string, standardOutput, standardError io.Writer) int {
	command, exitCode := New(standardOutput, standardError)
	command.SetArgs(arguments)
	if err := command.Execute(); err != nil {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError(err.Error()))
	}
	return *exitCode
}
