package conformance

import (
	"context"
	"errors"
	"testing"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
	"agent-wayfinder/storage"
)

type StoreFactory func(*testing.T) storage.Store

func RunStoreSuite(t *testing.T, open StoreFactory) {
	t.Helper()

	t.Run("publishes a complete workspace snapshot", func(t *testing.T) {
		store := open(t)
		published, err := store.Publish(context.Background(), storage.PublishRequest{
			Workspace: "workspace",
			Update:    graphUpdate(t, "src/main.ts", "function:main"),
		})
		if err != nil {
			t.Fatalf("publish workspace snapshot: %v", err)
		}
		if published.Workspace != "workspace" {
			t.Errorf("published workspace = %q, want workspace", published.Workspace)
		}
		if published.Version != 1 {
			t.Errorf("published version = %d, want 1", published.Version)
		}
		if published.PublishedAt.IsZero() {
			t.Error("published snapshot has zero publication time")
		}

		current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: "workspace"})
		if err != nil {
			t.Fatalf("open current snapshot: %v", err)
		}
		if current != published {
			t.Errorf("current snapshot = %+v, want %+v", current, published)
		}
	})

	t.Run("preserves published snapshots after a replacement", func(t *testing.T) {
		store := open(t)
		first, err := store.Publish(context.Background(), storage.PublishRequest{
			Workspace: "workspace",
			Update:    graphUpdate(t, "src/main.ts", "function:main"),
		})
		if err != nil {
			t.Fatalf("publish first snapshot: %v", err)
		}
		if _, err := store.Publish(context.Background(), storage.PublishRequest{
			Workspace: "workspace",
			Update:    graphUpdate(t, "src/main.ts", "function:replacement"),
		}); err != nil {
			t.Fatalf("publish replacement snapshot: %v", err)
		}

		firstMatches, err := store.LookupNodes(context.Background(), first, storage.NodeLookupRequest{Text: "function:", Limit: 10})
		if err != nil {
			t.Fatalf("look up first snapshot: %v", err)
		}
		if len(firstMatches) != 1 || firstMatches[0].Node.ID != "function:main" {
			t.Errorf("first snapshot matches = %+v, want function:main", firstMatches)
		}

		current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: "workspace"})
		if err != nil {
			t.Fatalf("open current snapshot: %v", err)
		}
		currentMatches, err := store.LookupNodes(context.Background(), current, storage.NodeLookupRequest{Text: "function:", Limit: 10})
		if err != nil {
			t.Fatalf("look up current snapshot: %v", err)
		}
		if len(currentMatches) != 1 || currentMatches[0].Node.ID != "function:replacement" {
			t.Errorf("current snapshot matches = %+v, want function:replacement", currentMatches)
		}
	})

	t.Run("searches structured lexical requests safely within snapshots", func(t *testing.T) {
		store := open(t)
		first, err := store.Publish(context.Background(), storage.PublishRequest{
			Workspace: "workspace",
			Update:    graphUpdate(t, "src/LegacyHandler.ts", "function:LegacyHandler"),
		})
		if err != nil {
			t.Fatalf("publish lexical snapshot: %v", err)
		}
		matches, err := store.SearchNodes(context.Background(), first, storage.LexicalSearchRequest{
			Text:        `legacy OR AND NOT NEAR ( ) + - * "unterminated`,
			Phrases:     []string{"legacy handler"},
			TokenGroups: [][]string{{"legacy", "handler"}},
			Kinds:       []graph.NodeKind{"function"},
			Limit:       10,
		})
		if err != nil {
			t.Fatalf("search lexical snapshot: %v", err)
		}
		if len(matches) != 1 || matches[0].Node.ID != "function:LegacyHandler" || matches[0].Score <= 0 || len(matches[0].MatchedFields) == 0 {
			t.Errorf("lexical matches = %+v, want scored legacy handler with matched fields", matches)
		}
		prefixMatches, err := store.SearchNodes(context.Background(), first, storage.LexicalSearchRequest{Text: "lega", Limit: 10})
		if err != nil {
			t.Fatalf("search lexical prefix: %v", err)
		}
		if len(prefixMatches) != 1 || prefixMatches[0].Node.ID != "function:LegacyHandler" {
			t.Errorf("lexical prefix matches = %+v, want legacy handler", prefixMatches)
		}

		current, err := store.Publish(context.Background(), storage.PublishRequest{
			Workspace: "workspace",
			Update:    graphUpdate(t, "src/LegacyHandler.ts", "function:ReplacementHandler"),
		})
		if err != nil {
			t.Fatalf("publish lexical replacement: %v", err)
		}
		currentMatches, err := store.SearchNodes(context.Background(), current, storage.LexicalSearchRequest{Text: "legacy", Limit: 10})
		if err != nil {
			t.Fatalf("search lexical replacement: %v", err)
		}
		for _, match := range currentMatches {
			if match.Node.ID == "function:LegacyHandler" {
				t.Errorf("replacement lexical matches include stale node: %+v", currentMatches)
			}
		}
	})

	t.Run("traverses outgoing facts within the requested boundary", func(t *testing.T) {
		store := open(t)
		snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
			Workspace: "workspace",
			Update: graphUpdateWithFacts(t, "src/main.ts", graph.Facts{
				Nodes: []graph.Node{
					graphNode("src/main.ts", "function:main"),
					graphNode("src/main.ts", "function:helper"),
				},
				Edges: []graph.Edge{{
					SourceID: "function:main",
					TargetID: "function:helper",
					Relation: "calls",
					Evidence: evidence("src/main.ts"),
				}},
			}),
		})
		if err != nil {
			t.Fatalf("publish traversal snapshot: %v", err)
		}

		result, err := store.Traverse(context.Background(), snapshot, storage.TraversalRequest{
			StartNodeIDs: []string{"function:main"},
			Direction:    storage.TraverseOutgoing,
			MaxDepth:     1,
			MaxNodes:     2,
		})
		if err != nil {
			t.Fatalf("traverse outgoing facts: %v", err)
		}
		if len(result.Facts.Nodes) != 2 || result.Facts.Nodes[0].ID != "function:helper" || result.Facts.Nodes[1].ID != "function:main" {
			t.Errorf("traversed nodes = %+v, want helper and main", result.Facts.Nodes)
		}
		if len(result.Facts.Edges) != 1 || result.Facts.Edges[0].Relation != "calls" {
			t.Errorf("traversed edges = %+v, want one calls edge", result.Facts.Edges)
		}
		if result.Truncated() {
			t.Errorf("traversal result is unexpectedly truncated: %+v", result.TruncationReasons)
		}
	})

	t.Run("explains a node with its supporting incident facts", func(t *testing.T) {
		store := open(t)
		snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
			Workspace: "workspace",
			Update: graphUpdateWithFacts(t, "src/main.ts", graph.Facts{
				Nodes: []graph.Node{
					graphNode("src/main.ts", "function:main"),
					graphNode("src/main.ts", "function:helper"),
				},
				Edges: []graph.Edge{{
					SourceID: "function:main",
					TargetID: "function:helper",
					Relation: "calls",
					Evidence: evidence("src/main.ts"),
				}},
			}),
		})
		if err != nil {
			t.Fatalf("publish explanation snapshot: %v", err)
		}

		explanation, err := store.Explain(context.Background(), snapshot, storage.ExplainRequest{NodeID: "function:helper"})
		if err != nil {
			t.Fatalf("explain graph node: %v", err)
		}
		if explanation.Node.ID != "function:helper" {
			t.Errorf("explained node = %q, want function:helper", explanation.Node.ID)
		}
		if len(explanation.SupportingFacts.Nodes) != 2 || len(explanation.SupportingFacts.Edges) != 1 {
			t.Errorf("supporting facts = %+v, want two nodes and one edge", explanation.SupportingFacts)
		}
	})

	t.Run("exports facts filtered by node kind and relation", func(t *testing.T) {
		store := open(t)
		snapshot, err := store.Publish(context.Background(), storage.PublishRequest{
			Workspace: "workspace",
			Update: graphUpdateWithFacts(t, "src/main.ts", graph.Facts{
				Nodes: []graph.Node{
					graphNode("src/main.ts", "function:main"),
					graphNode("src/main.ts", "function:helper"),
					{ID: "class:ignored", Kind: "class", Evidence: evidence("src/main.ts")},
				},
				Edges: []graph.Edge{{
					SourceID: "function:main",
					TargetID: "function:helper",
					Relation: "calls",
					Evidence: evidence("src/main.ts"),
				}},
			}),
		})
		if err != nil {
			t.Fatalf("publish export snapshot: %v", err)
		}

		var sink factCollector
		if err := store.Export(context.Background(), snapshot, storage.ExportRequest{
			NodeKinds: []graph.NodeKind{"function"},
			Relations: []graph.RelationKind{"calls"},
		}, &sink); err != nil {
			t.Fatalf("export filtered facts: %v", err)
		}
		if len(sink.nodes) != 2 || sink.nodes[0].ID != "function:helper" || sink.nodes[1].ID != "function:main" {
			t.Errorf("exported nodes = %+v, want helper and main", sink.nodes)
		}
		if len(sink.edges) != 1 || sink.edges[0].Relation != "calls" {
			t.Errorf("exported edges = %+v, want one calls edge", sink.edges)
		}
	})

	t.Run("rolls back the current graph to a named snapshot", func(t *testing.T) {
		store := open(t)
		first, err := store.Publish(context.Background(), storage.PublishRequest{
			Workspace: "workspace",
			Update:    graphUpdate(t, "src/main.ts", "function:main"),
		})
		if err != nil {
			t.Fatalf("publish first rollback snapshot: %v", err)
		}
		if _, err := store.Publish(context.Background(), storage.PublishRequest{
			Workspace: "workspace",
			Update:    graphUpdate(t, "src/main.ts", "function:replacement"),
		}); err != nil {
			t.Fatalf("publish replacement rollback snapshot: %v", err)
		}

		rolledBack, err := store.Rollback(context.Background(), storage.RollbackRequest{Workspace: "workspace", Version: first.Version})
		if err != nil {
			t.Fatalf("roll back graph: %v", err)
		}
		if rolledBack != first {
			t.Errorf("rolled back snapshot = %+v, want %+v", rolledBack, first)
		}

		current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: "workspace"})
		if err != nil {
			t.Fatalf("open current rollback snapshot: %v", err)
		}
		matches, err := store.LookupNodes(context.Background(), current, storage.NodeLookupRequest{Text: "function:", Limit: 10})
		if err != nil {
			t.Fatalf("look up rolled back snapshot: %v", err)
		}
		if len(matches) != 1 || matches[0].Node.ID != "function:main" {
			t.Errorf("rolled back snapshot matches = %+v, want function:main", matches)
		}
	})

	t.Run("prunes snapshots before the retained version", func(t *testing.T) {
		store := open(t)
		first, err := store.Publish(context.Background(), storage.PublishRequest{
			Workspace: "workspace",
			Update:    graphUpdate(t, "src/main.ts", "function:main"),
		})
		if err != nil {
			t.Fatalf("publish first prunable snapshot: %v", err)
		}
		retained, err := store.Publish(context.Background(), storage.PublishRequest{
			Workspace: "workspace",
			Update:    graphUpdate(t, "src/main.ts", "function:replacement"),
		})
		if err != nil {
			t.Fatalf("publish retained snapshot: %v", err)
		}

		result, err := store.Prune(context.Background(), storage.PruneRequest{Workspace: "workspace", BeforeVersion: retained.Version})
		if err != nil {
			t.Fatalf("prune graph versions: %v", err)
		}
		if result.PrunedVersions != 1 {
			t.Errorf("pruned versions = %d, want 1", result.PrunedVersions)
		}

		version := first.Version
		if _, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: "workspace", Version: &version}); !errors.Is(err, storage.ErrGraphVersionPruned) {
			t.Errorf("open pruned snapshot error = %v, want %v", err, storage.ErrGraphVersionPruned)
		}
		current, err := store.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{Workspace: "workspace"})
		if err != nil {
			t.Fatalf("open retained current snapshot: %v", err)
		}
		if current != retained {
			t.Errorf("current snapshot after prune = %+v, want %+v", current, retained)
		}
	})
}

func graphUpdate(t *testing.T, sourcePath, nodeID string) extractor.GraphUpdate {
	t.Helper()
	return graphUpdateWithFacts(t, sourcePath, graph.Facts{Nodes: []graph.Node{graphNode(sourcePath, nodeID)}})
}

func graphUpdateWithFacts(t *testing.T, sourcePath string, facts graph.Facts) extractor.GraphUpdate {
	t.Helper()
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: []graph.NodeKind{"function", "class"},
		Relations: []graph.RelationDefinition{{
			Kind: "calls",
			Endpoints: []graph.EndpointRule{{
				Source: "function",
				Target: "function",
			}},
		}},
	})
	if err != nil {
		t.Fatalf("create vocabulary: %v", err)
	}
	contribution, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{
		SourcePath: sourcePath,
		Metadata:   extractor.Metadata{Name: "conformance", Version: "1", Extensions: []string{".test"}},
		Facts:      facts,
	})
	if err != nil {
		t.Fatalf("create contribution: %v", err)
	}
	update, err := extractor.NewGraphUpdate([]extractor.Contribution{contribution})
	if err != nil {
		t.Fatalf("create graph update: %v", err)
	}
	return update
}

func graphNode(sourcePath, nodeID string) graph.Node {
	return graph.Node{ID: nodeID, Kind: "function", Evidence: evidence(sourcePath)}
}

func evidence(sourcePath string) graph.FactEvidence {
	return graph.FactEvidence{
		Span:       graph.SourceSpan{Path: sourcePath, StartLine: 1, StartColumn: 1, EndLine: 1, EndColumn: 1},
		FileHash:   "conformance",
		Extractor:  "conformance@1",
		Provenance: "test",
		Confidence: graph.ConfidenceExtracted,
	}
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
