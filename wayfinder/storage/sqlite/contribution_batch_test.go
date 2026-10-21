package sqlite

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
)

func TestContributionSessionBatchFlushesAtSourceLimit(t *testing.T) {
	store, err := Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	store.contributionBatchLimits = contributionBatchLimits{maximumRows: 100, maximumBytes: 1 << 20, maximumSources: 2}

	if _, err := store.database.Exec(`
		CREATE TRIGGER fail_contribution_batch
		BEFORE INSERT ON contribution_nodes
		BEGIN
			SELECT RAISE(ABORT, 'injected contribution batch failure');
		END`); err != nil {
		t.Fatalf("create failure trigger: %v", err)
	}

	session, err := store.BeginContributionSession(context.Background(), "workspace")
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	for _, sourcePath := range []string{"src/first.ts", "src/second.ts"} {
		if err := session.StageSource(context.Background(), sourcePath); err != nil {
			t.Fatalf("stage source %q: %v", sourcePath, err)
		}
	}
	if err := session.WriteContribution(context.Background(), batchTestContribution(t, "src/first.ts", "function:first")); err != nil {
		t.Fatalf("write first buffered contribution: %v", err)
	}
	if err := session.WriteContribution(context.Background(), batchTestContribution(t, "src/second.ts", "function:second")); err == nil || !strings.Contains(err.Error(), "injected contribution batch failure") {
		t.Fatalf("write contribution at source limit = %v, want injected batch failure", err)
	}
}

func TestContributionSessionBatchFlushesAtRowLimit(t *testing.T) {
	store, err := Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	store.contributionBatchLimits = contributionBatchLimits{maximumRows: 5, maximumBytes: 1 << 20, maximumSources: 100}

	if _, err := store.database.Exec(`
		CREATE TRIGGER fail_contribution_batch
		BEFORE INSERT ON contribution_nodes
		BEGIN
			SELECT RAISE(ABORT, 'injected contribution batch failure');
		END`); err != nil {
		t.Fatalf("create failure trigger: %v", err)
	}

	session, err := store.BeginContributionSession(context.Background(), "workspace")
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	for _, sourcePath := range []string{"src/first.ts", "src/second.ts"} {
		if err := session.StageSource(context.Background(), sourcePath); err != nil {
			t.Fatalf("stage source %q: %v", sourcePath, err)
		}
	}
	if err := session.WriteContribution(context.Background(), batchTestContribution(t, "src/first.ts", "function:first")); err != nil {
		t.Fatalf("write first buffered contribution: %v", err)
	}
	if err := session.WriteContribution(context.Background(), batchTestContribution(t, "src/second.ts", "function:second")); err == nil || !strings.Contains(err.Error(), "injected contribution batch failure") {
		t.Fatalf("write contribution at row limit = %v, want injected batch failure", err)
	}
}

func TestContributionSessionBatchFlushesAtEstimatedByteLimit(t *testing.T) {
	store, err := Open(context.Background(), filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	store.contributionBatchLimits = contributionBatchLimits{maximumRows: 100, maximumBytes: 1, maximumSources: 100}

	if _, err := store.database.Exec(`
		CREATE TRIGGER fail_contribution_batch
		BEFORE INSERT ON contribution_nodes
		BEGIN
			SELECT RAISE(ABORT, 'injected contribution batch failure');
		END`); err != nil {
		t.Fatalf("create failure trigger: %v", err)
	}

	session, err := store.BeginContributionSession(context.Background(), "workspace")
	if err != nil {
		t.Fatalf("begin contribution session: %v", err)
	}
	if err := session.StageSource(context.Background(), "src/main.ts"); err != nil {
		t.Fatalf("stage source: %v", err)
	}
	if err := session.WriteContribution(context.Background(), batchTestContribution(t, "src/main.ts", "function:main")); err == nil || !strings.Contains(err.Error(), "injected contribution batch failure") {
		t.Fatalf("write contribution at estimated byte limit = %v, want injected batch failure", err)
	}
}

func batchTestContribution(t *testing.T, sourcePath, nodeID string) extractor.Contribution {
	t.Helper()
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{"function"}})
	if err != nil {
		t.Fatalf("create vocabulary: %v", err)
	}
	contribution, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{
		ProjectID:  "project:fixture",
		SourcePath: sourcePath,
		Metadata:   extractor.Metadata{Name: "typescript", Version: "1", Extensions: []string{".ts"}},
		Facts: graph.Facts{Nodes: []graph.Node{{
			ID:   nodeID,
			Kind: "function",
			Evidence: graph.FactEvidence{
				Span:       graph.SourceSpan{Path: sourcePath, StartLine: 1, StartColumn: 1, EndLine: 1, EndColumn: 5},
				FileHash:   "content-hash",
				Extractor:  "typescript@1",
				Provenance: "syntax",
				Confidence: graph.ConfidenceExtracted,
			},
		}}},
	})
	if err != nil {
		t.Fatalf("create contribution: %v", err)
	}
	return contribution
}
