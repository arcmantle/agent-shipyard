package ask

import (
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"agent-wayfinder/cli"
	"agent-wayfinder/cmd/agent-wayfinder/catalog"
	cmd "agent-wayfinder/cmd/agent-wayfinder/internal/command"
	querycommand "agent-wayfinder/cmd/agent-wayfinder/query"
	"agent-wayfinder/query"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"

	"github.com/spf13/cobra"
)

func New(standardOutput, standardError io.Writer, exitCode *int) *cobra.Command {
	return cmd.NewLeaf("ask", "Ask an AI-planned graph question", func(command *cobra.Command) {
		cmd.DatabaseAndFormatFlags(command)
		command.Flags().String("path", ".", "workspace path")
		command.Flags().Int("max-depth", 2, "maximum traversal depth")
		command.Flags().Int("max-nodes", 100, "maximum traversed nodes")
		command.Flags().Bool("diagnostics", false, "include generated SQL and parameters")
	}, runAsk, standardOutput, standardError, exitCode)
}

func runAsk(command *cobra.Command, arguments []string, standardOutput, standardError io.Writer) int {
	if len(arguments) != 1 || strings.TrimSpace(arguments[0]) == "" {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("ask requires one question; use --path for the workspace"))
	}
	format, err := cmd.Format(command)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	workspace, _ := command.Flags().GetString("path")
	workspaceRoot, err := filepath.Abs(workspace)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	database, err := cmd.DatabasePathForCommand(command, workspaceRoot)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	ctx := command.Context()
	store, err := sqlite.Open(ctx, database)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	defer store.Close()
	snapshot, err := store.OpenSnapshot(ctx, storage.OpenSnapshotRequest{Workspace: workspaceRoot})
	if errors.Is(err, storage.ErrWorkspaceNotFound) {
		return cmd.WriteError(standardError, cli.NewIndexUnavailableError(workspaceRoot))
	}
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	planner, err := NewPlanner(workspaceRoot, store)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	embedding, err := catalog.NewEmbeddingGenerator(workspaceRoot, nil)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	maxDepth, _ := command.Flags().GetInt("max-depth")
	maxNodes, _ := command.Flags().GetInt("max-nodes")
	diagnostics, _ := command.Flags().GetBool("diagnostics")
	result, err := query.AskSnapshot(ctx, store, snapshot, arguments[0], query.GraphQueryLimits{MaxDepth: maxDepth, MaxNodes: maxNodes}, query.AskOptions{
		Planner: planner, GraphQueryOptions: query.GraphQueryOptions{EmbeddingGenerator: embedding, Diagnostics: diagnostics},
	})
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	var text strings.Builder
	fmt.Fprintf(&text, "Query: %s\nConfidence: %.2f\n", result.SelectedSource, result.Confidence)
	for _, basis := range result.ConfidenceBasis {
		fmt.Fprintln(&text, basis)
	}
	fmt.Fprintln(&text, querycommand.GraphQueryText(result.GraphQueryResult))
	if err := cli.Render(standardOutput, cli.Result{Snapshot: snapshot, Text: strings.TrimSpace(text.String()), Data: result}, format); err != nil {
		return cmd.WriteError(standardError, err)
	}
	return 0
}
