package command

import (
	"io"
	"path/filepath"

	"agent-wayfinder/cli"

	"github.com/spf13/cobra"
)

func NewLeaf(use, short string, configure func(*cobra.Command), runCommand func(*cobra.Command, []string, io.Writer, io.Writer) int, standardOutput, standardError io.Writer, exitCode *int) *cobra.Command {
	command := &cobra.Command{
		Use:   use,
		Short: short,
		Run: func(command *cobra.Command, arguments []string) {
			*exitCode = runCommand(command, arguments, standardOutput, standardError)
		},
	}
	configure(command)
	return command
}

func FormatFlag(command *cobra.Command) {
	command.Flags().String("format", "", "output format: text or json")
}

func DatabaseAndFormatFlags(command *cobra.Command) {
	command.Flags().String("database", "", "SQLite database path")
	FormatFlag(command)
}

func Format(command *cobra.Command) (cli.Format, error) {
	value, err := command.Flags().GetString("format")
	if err != nil {
		return "", err
	}
	return cli.ParseFormat(value)
}

func DatabasePathForCommand(command *cobra.Command, workspace string) (string, error) {
	value, err := command.Flags().GetString("database")
	if err != nil {
		return "", err
	}
	return DatabasePath(workspace, value)
}

func DatabasePath(workspace, database string) (string, error) {
	workspaceRoot, err := filepath.Abs(workspace)
	if err != nil {
		return "", err
	}
	if database == "" {
		return filepath.Join(workspaceRoot, ".agent-wayfinder", "graph.db"), nil
	}
	return filepath.Abs(database)
}

func WriteError(standardError io.Writer, err error) int {
	if renderErr := cli.RenderError(standardError, err); renderErr != nil {
		return 1
	}
	return cli.ExitCode(err)
}
