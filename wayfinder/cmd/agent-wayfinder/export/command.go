package export

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"

	"agent-wayfinder/cli"
	cmd "agent-wayfinder/cmd/agent-wayfinder/internal/command"
	"agent-wayfinder/graph"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"

	"github.com/spf13/cobra"
)

func New(standardOutput, standardError io.Writer, exitCode *int) *cobra.Command {
	return cmd.NewLeaf("export WORKSPACE", "Export a published graph", cmd.DatabaseAndFormatFlags, run, standardOutput, standardError, exitCode)
}

func run(command *cobra.Command, arguments []string, standardOutput, standardError io.Writer) int {
	if len(arguments) != 1 {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("export requires one workspace path"))
	}
	format, err := cmd.Format(command)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}

	workspace := arguments[0]
	workspaceRoot, err := filepath.Abs(workspace)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve export workspace path: %w", err))
	}
	database, err := cmd.DatabasePathForCommand(command, workspaceRoot)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve export database path: %w", err))
	}
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("open export database: %w", err))
	}
	defer store.Close()

	snapshot, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspaceRoot})
	if errors.Is(err, storage.ErrWorkspaceNotFound) {
		return cmd.WriteError(standardError, cli.NewIndexUnavailableError(workspaceRoot))
	}
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	collector := &factCollector{}
	if err := store.Export(context.Background(), snapshot, storage.ExportRequest{}, collector); err != nil {
		return cmd.WriteError(standardError, err)
	}
	data := struct {
		Nodes []graph.Node `json:"nodes"`
		Edges []graph.Edge `json:"edges"`
	}{
		Nodes: collector.nodes,
		Edges: collector.edges,
	}
	if err := cli.Render(standardOutput, cli.Result{
		Snapshot: snapshot,
		Text:     fmt.Sprintf("Nodes: %d\nEdges: %d", len(data.Nodes), len(data.Edges)),
		Data:     data,
	}, format); err != nil {
		return cmd.WriteError(standardError, err)
	}
	return 0
}

type factCollector struct {
	nodes []graph.Node
	edges []graph.Edge
}

func (collector *factCollector) WriteNode(node graph.Node) error {
	collector.nodes = append(collector.nodes, node)
	return nil
}

func (collector *factCollector) WriteEdge(edge graph.Edge) error {
	collector.edges = append(collector.edges, edge)
	return nil
}
