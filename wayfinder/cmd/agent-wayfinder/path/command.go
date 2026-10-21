package path

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"agent-wayfinder/cli"
	cmd "agent-wayfinder/cmd/agent-wayfinder/internal/command"
	query_cmd "agent-wayfinder/cmd/agent-wayfinder/query"
	"agent-wayfinder/graph"
	"agent-wayfinder/query"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"

	"github.com/spf13/cobra"
)

func New(standardOutput, standardError io.Writer, exitCode *int) *cobra.Command {
	return cmd.NewLeaf("path WORKSPACE SOURCE TARGET", "Find a graph path", configure, run, standardOutput, standardError, exitCode)
}

func configure(command *cobra.Command) {
	cmd.DatabaseAndFormatFlags(command)
	command.Flags().Bool("undirected", false, "allow undirected fallback")
	command.Flags().Int("max-depth", 8, "maximum path depth")
	command.Flags().Int("max-nodes", 100, "maximum traversed nodes")
	command.Flags().StringArray("project", nil, "project scope ID")
	command.Flags().StringArray("relation", nil, "allowed relation")
}

func run(command *cobra.Command, arguments []string, standardOutput, standardError io.Writer) int {
	if len(arguments) != 3 {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("path requires one workspace path, one source query, and one target query"))
	}
	format, err := cmd.Format(command)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	undirected, err := command.Flags().GetBool("undirected")
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	maxDepth, err := command.Flags().GetInt("max-depth")
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	maxNodes, err := command.Flags().GetInt("max-nodes")
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	projectIDs, err := command.Flags().GetStringArray("project")
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	relations, err := command.Flags().GetStringArray("relation")
	if err != nil {
		return cmd.WriteError(standardError, err)
	}

	workspace, source, target := arguments[0], arguments[1], arguments[2]
	workspaceRoot, err := filepath.Abs(workspace)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve path workspace path: %w", err))
	}
	database, err := cmd.DatabasePathForCommand(command, workspaceRoot)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve path database path: %w", err))
	}
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("open path database: %w", err))
	}
	defer store.Close()

	snapshot, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspaceRoot})
	if errors.Is(err, storage.ErrWorkspaceNotFound) {
		return cmd.WriteError(standardError, cli.NewIndexUnavailableError(workspaceRoot))
	}
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	result, err := query.FindPathSnapshot(context.Background(), store, store, snapshot, query.PathRequest{
		Source:                  source,
		Target:                  target,
		AllowUndirectedFallback: undirected,
		ProjectIDs:              append([]string(nil), projectIDs...),
		Relations:               query_cmd.RelationKinds(relations),
		MaxDepth:                maxDepth,
		MaxNodes:                maxNodes,
	})
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	data := resultData(result, maxDepth, maxNodes)
	if err := cli.Render(standardOutput, cli.Result{
		Snapshot: snapshot,
		Text:     renderText(data),
		Data:     data,
	}, format); err != nil {
		return cmd.WriteError(standardError, err)
	}
	return 0
}

type result struct {
	SourceCandidates            []graph.Node         `json:"sourceCandidates,omitempty"`
	SourceRemainderCount        int                  `json:"sourceRemainderCount,omitempty"`
	TargetCandidates            []graph.Node         `json:"targetCandidates,omitempty"`
	TargetRemainderCount        int                  `json:"targetRemainderCount,omitempty"`
	Nodes                       []graph.Node         `json:"nodes,omitempty"`
	Edges                       []graph.Edge         `json:"edges,omitempty"`
	ScopeBoundary               *query.ScopeBoundary `json:"scopeBoundary,omitempty"`
	UsedUndirectedFallback      bool                 `json:"usedUndirectedFallback"`
	UndirectedFallbackAttempted bool                 `json:"undirectedFallbackAttempted"`
	MaxDepth                    int                  `json:"maxDepth"`
	MaxNodes                    int                  `json:"maxNodes"`
}

func resultData(pathResult query.PathResult, maxDepth, maxNodes int) result {
	return result{
		SourceCandidates:            pathResult.SourceCandidates,
		SourceRemainderCount:        pathResult.SourceRemainderCount,
		TargetCandidates:            pathResult.TargetCandidates,
		TargetRemainderCount:        pathResult.TargetRemainderCount,
		Nodes:                       pathResult.Nodes,
		Edges:                       pathResult.Edges,
		ScopeBoundary:               pathResult.ScopeBoundary,
		UsedUndirectedFallback:      pathResult.UsedUndirectedFallback,
		UndirectedFallbackAttempted: pathResult.UndirectedFallbackAttempted,
		MaxDepth:                    maxDepth,
		MaxNodes:                    maxNodes,
	}
}

func renderText(result result) string {
	if len(result.SourceCandidates) > 0 || len(result.TargetCandidates) > 0 {
		return renderCandidates(result)
	}
	if len(result.Nodes) == 0 {
		if result.UndirectedFallbackAttempted {
			return "No path found."
		}
		return "No directed path found."
	}
	lines := []string{fmt.Sprintf("Path (%d hops):", len(result.Edges))}
	for index, node := range result.Nodes {
		lines = append(lines, node.QualifiedName)
		if index < len(result.Edges) {
			edge := result.Edges[index]
			if edge.SourceID == node.ID {
				lines = append(lines, fmt.Sprintf("  --%s--> ", edge.Relation))
			} else {
				lines = append(lines, fmt.Sprintf("  <--%s-- ", edge.Relation))
			}
		}
	}
	if result.UsedUndirectedFallback {
		lines = append(lines, "Used undirected fallback.")
	}
	if result.ScopeBoundary != nil {
		lines = append(lines, fmt.Sprintf("Scope boundary: %s", result.ScopeBoundary.Node.QualifiedName))
	}
	return strings.Join(lines, "\n")
}

func renderCandidates(result result) string {
	lines := []string{"Ambiguous path endpoint."}
	appendCandidates := func(label string, candidates []graph.Node, remainder int) {
		if len(candidates) == 0 {
			return
		}
		lines = append(lines, label+":")
		for _, candidate := range candidates {
			lines = append(lines, fmt.Sprintf("- %s: %s", candidate.ID, candidate.QualifiedName))
		}
		if remainder > 0 {
			lines = append(lines, fmt.Sprintf("- %d additional candidate(s)", remainder))
		}
	}
	appendCandidates("Source candidates", result.SourceCandidates, result.SourceRemainderCount)
	appendCandidates("Target candidates", result.TargetCandidates, result.TargetRemainderCount)
	return strings.Join(lines, "\n")
}
