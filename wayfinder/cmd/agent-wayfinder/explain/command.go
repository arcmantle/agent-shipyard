package explain

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"sort"
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
	return cmd.NewLeaf("inspect WORKSPACE NODE", "Inspect a graph node", cmd.DatabaseAndFormatFlags, run, standardOutput, standardError, exitCode)
}

func run(command *cobra.Command, arguments []string, standardOutput, standardError io.Writer) int {
	if len(arguments) != 2 {
		return cmd.WriteError(standardError, cli.NewInvalidArgumentError("inspect requires one workspace path and one node query"))
	}
	format, err := cmd.Format(command)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}

	workspace, term := arguments[0], arguments[1]
	workspaceRoot, err := filepath.Abs(workspace)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve inspect workspace path: %w", err))
	}
	database, err := cmd.DatabasePathForCommand(command, workspaceRoot)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("resolve inspect database path: %w", err))
	}
	store, err := sqlite.Open(context.Background(), database)
	if err != nil {
		return cmd.WriteError(standardError, fmt.Errorf("open inspect database: %w", err))
	}
	defer store.Close()

	snapshot, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: workspaceRoot})
	if errors.Is(err, storage.ErrWorkspaceNotFound) {
		return cmd.WriteError(standardError, cli.NewIndexUnavailableError(workspaceRoot))
	}
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	result, err := query.ExplainSnapshot(context.Background(), store, store, snapshot, term)
	if err != nil {
		return cmd.WriteError(standardError, err)
	}
	data := resultData(result)
	if result.Explanation != nil {
		entries, err := store.ReadCatalogEntries(context.Background(), snapshot, storage.CatalogEntryReadRequest{NodeIDs: []string{result.Explanation.Node.ID}})
		if err != nil {
			return cmd.WriteError(standardError, err)
		}
		data.CatalogEvidence = query_cmd.CatalogEvidenceData(entries)
	}
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
	Candidates      []graph.Node                        `json:"candidates,omitempty"`
	RemainderCount  int                                 `json:"remainderCount,omitempty"`
	Explanation     *storage.Explanation                `json:"explanation,omitempty"`
	CatalogEvidence []query_cmd.CatalogSynopsisEvidence `json:"catalogEvidence,omitempty"`
}

func resultData(queryResult query.ExplainResult) result {
	return result{
		Candidates:     queryResult.Candidates,
		RemainderCount: queryResult.RemainderCount,
		Explanation:    queryResult.Explanation,
	}
}

func renderText(result result) string {
	if result.Explanation == nil {
		if len(result.Candidates) == 0 {
			return "No matching node."
		}
		lines := []string{"Ambiguous node query. Candidates:"}
		for _, candidate := range result.Candidates {
			lines = append(lines, fmt.Sprintf("- %s: %s", candidate.ID, candidate.QualifiedName))
		}
		if result.RemainderCount > 0 {
			lines = append(lines, fmt.Sprintf("- %d additional candidate(s)", result.RemainderCount))
		}
		return strings.Join(lines, "\n")
	}

	node := result.Explanation.Node
	lines := []string{
		fmt.Sprintf("Node: %s", node.ID),
		fmt.Sprintf("Name: %s", node.QualifiedName),
		fmt.Sprintf("Kind: %s", node.Kind),
		fmt.Sprintf("Source: %s:%d:%d-%d:%d", node.Evidence.Span.Path, node.Evidence.Span.StartLine, node.Evidence.Span.StartColumn, node.Evidence.Span.EndLine, node.Evidence.Span.EndColumn),
		fmt.Sprintf("Extractor: %s", node.Evidence.Extractor),
		fmt.Sprintf("Provenance: %s", node.Evidence.Provenance),
		fmt.Sprintf("Confidence: %s", node.Evidence.Confidence),
		"",
		"Direct edges:",
	}
	groups := make(map[graph.RelationKind][]graph.Edge)
	for _, edge := range result.Explanation.SupportingFacts.Edges {
		groups[edge.Relation] = append(groups[edge.Relation], edge)
	}
	relations := make([]string, 0, len(groups))
	for relation := range groups {
		relations = append(relations, string(relation))
	}
	sort.Strings(relations)
	for _, relation := range relations {
		edges := groups[graph.RelationKind(relation)]
		sort.Slice(edges, func(left, right int) bool {
			if edges[left].SourceID != edges[right].SourceID {
				return edges[left].SourceID < edges[right].SourceID
			}
			return edges[left].TargetID < edges[right].TargetID
		})
		lines = append(lines, fmt.Sprintf("%s (%d):", relation, len(edges)))
		for _, edge := range edges {
			lines = append(lines, fmt.Sprintf("- %s -> %s [%s, %s]", edge.SourceID, edge.TargetID, edge.Evidence.Confidence, edge.Evidence.Span.Path))
		}
	}
	if len(relations) == 0 {
		lines = append(lines, "None.")
	}
	if len(result.CatalogEvidence) > 0 {
		lines = append(lines, "", "Catalog evidence:")
		for _, evidence := range result.CatalogEvidence {
			lines = append(lines, fmt.Sprintf("- %s: %s", evidence.Generator, evidence.Synopsis))
		}
	}
	return strings.Join(lines, "\n")
}
