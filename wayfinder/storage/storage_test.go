package storage_test

import (
	"context"
	"errors"
	"testing"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
	"agent-wayfinder/storage"
)

func TestOpenSnapshotRequestSelectsNamedVersion(t *testing.T) {
	version := storage.GraphVersion(7)
	request := storage.OpenSnapshotRequest{
		Workspace: "workspace",
		Version:   &version,
	}

	if request.Version == nil {
		t.Fatal("open snapshot request version is nil")
	}
	if got := *request.Version; got != version {
		t.Errorf("open snapshot request version = %d, want %d", got, version)
	}
}

func TestOpenSnapshotRequestWithoutVersionSelectsLatest(t *testing.T) {
	request := storage.OpenSnapshotRequest{Workspace: "workspace"}
	if request.Version != nil {
		t.Fatalf("open snapshot request version = %d, want nil", *request.Version)
	}
}

func TestSnapshotOpenerAcceptsNamedVersion(t *testing.T) {
	version := storage.GraphVersion(7)
	opener := snapshotOpenerFunc(func(_ context.Context, request storage.OpenSnapshotRequest) (storage.Snapshot, error) {
		return storage.Snapshot{
			Workspace: request.Workspace,
			Version:   *request.Version,
		}, nil
	})

	snapshot, err := opener.OpenSnapshot(context.Background(), storage.OpenSnapshotRequest{
		Workspace: "workspace",
		Version:   &version,
	})
	if err != nil {
		t.Fatalf("open named snapshot: %v", err)
	}
	if snapshot.Version != version {
		t.Errorf("snapshot version = %d, want %d", snapshot.Version, version)
	}
}

type snapshotOpenerFunc func(context.Context, storage.OpenSnapshotRequest) (storage.Snapshot, error)

func (opener snapshotOpenerFunc) OpenSnapshot(ctx context.Context, request storage.OpenSnapshotRequest) (storage.Snapshot, error) {
	return opener(ctx, request)
}

var _ storage.SnapshotOpener = snapshotOpenerFunc(nil)

func TestPublisherPublishesWorkspaceUpdate(t *testing.T) {
	publisher := publisherFunc(func(_ context.Context, request storage.PublishRequest) (storage.Snapshot, error) {
		return storage.Snapshot{Workspace: request.Workspace, Version: 8}, nil
	})

	snapshot, err := publisher.Publish(context.Background(), storage.PublishRequest{Workspace: "workspace"})
	if err != nil {
		t.Fatalf("publish update: %v", err)
	}
	if snapshot.Workspace != "workspace" {
		t.Errorf("published workspace = %q, want %q", snapshot.Workspace, "workspace")
	}
}

type publisherFunc func(context.Context, storage.PublishRequest) (storage.Snapshot, error)

func (publisher publisherFunc) Publish(ctx context.Context, request storage.PublishRequest) (storage.Snapshot, error) {
	return publisher(ctx, request)
}

var _ storage.Publisher = publisherFunc(nil)

func TestAffectedSourceFinderUsesSpecifiedSnapshot(t *testing.T) {
	version := storage.GraphVersion(7)
	finder := affectedSourceFinderFunc(func(_ context.Context, snapshot storage.Snapshot, _ storage.AffectedSourcesRequest) ([]string, error) {
		if snapshot.Version != version {
			t.Errorf("affected source snapshot version = %d, want %d", snapshot.Version, version)
		}
		return []string{"src/main.ts"}, nil
	})

	affected, err := finder.AffectedSources(context.Background(), storage.Snapshot{Workspace: "workspace", Version: version}, storage.AffectedSourcesRequest{})
	if err != nil {
		t.Fatalf("find affected sources: %v", err)
	}
	if len(affected) != 1 || affected[0] != "src/main.ts" {
		t.Errorf("affected sources = %q, want src/main.ts", affected)
	}
}

type affectedSourceFinderFunc func(context.Context, storage.Snapshot, storage.AffectedSourcesRequest) ([]string, error)

func (finder affectedSourceFinderFunc) AffectedSources(ctx context.Context, snapshot storage.Snapshot, request storage.AffectedSourcesRequest) ([]string, error) {
	return finder(ctx, snapshot, request)
}

var _ storage.AffectedSourceFinder = affectedSourceFinderFunc(nil)

func TestNodeLookupUsesSpecifiedSnapshot(t *testing.T) {
	version := storage.GraphVersion(7)
	lookup := nodeLookupFunc(func(_ context.Context, snapshot storage.Snapshot, _ storage.NodeLookupRequest) ([]storage.NodeMatch, error) {
		if snapshot.Version != version {
			t.Errorf("lookup snapshot version = %d, want %d", snapshot.Version, version)
		}
		return nil, nil
	})

	_, err := lookup.LookupNodes(context.Background(), storage.Snapshot{Workspace: "workspace", Version: version}, storage.NodeLookupRequest{Text: "main"})
	if err != nil {
		t.Fatalf("lookup nodes: %v", err)
	}
}

type nodeLookupFunc func(context.Context, storage.Snapshot, storage.NodeLookupRequest) ([]storage.NodeMatch, error)

func (lookup nodeLookupFunc) LookupNodes(ctx context.Context, snapshot storage.Snapshot, request storage.NodeLookupRequest) ([]storage.NodeMatch, error) {
	return lookup(ctx, snapshot, request)
}

var _ storage.NodeLookup = nodeLookupFunc(nil)

func TestTraversalUsesBoundedRequestForSpecifiedSnapshot(t *testing.T) {
	version := storage.GraphVersion(7)
	traversal := traversalFunc(func(_ context.Context, snapshot storage.Snapshot, request storage.TraversalRequest) (storage.TraversalResult, error) {
		if snapshot.Version != version {
			t.Errorf("traversal snapshot version = %d, want %d", snapshot.Version, version)
		}
		if request.MaxDepth != 2 {
			t.Errorf("traversal maximum depth = %d, want %d", request.MaxDepth, 2)
		}
		return storage.TraversalResult{}, nil
	})

	_, err := traversal.Traverse(context.Background(), storage.Snapshot{Workspace: "workspace", Version: version}, storage.TraversalRequest{
		StartNodeIDs: []string{"function:main"},
		Direction:    storage.TraverseOutgoing,
		MaxDepth:     2,
		MaxNodes:     20,
	})
	if err != nil {
		t.Fatalf("traverse graph: %v", err)
	}
}

func TestTraversalResultReportsTruncationBoundary(t *testing.T) {
	result := storage.TraversalResult{TruncationReasons: []storage.TruncationReason{storage.TruncatedByNodeLimit}}
	if !result.Truncated() {
		t.Fatal("traversal result is not truncated")
	}
}

type traversalFunc func(context.Context, storage.Snapshot, storage.TraversalRequest) (storage.TraversalResult, error)

func (traversal traversalFunc) Traverse(ctx context.Context, snapshot storage.Snapshot, request storage.TraversalRequest) (storage.TraversalResult, error) {
	return traversal(ctx, snapshot, request)
}

var _ storage.Traverser = traversalFunc(nil)

func TestExplainerUsesSpecifiedSnapshot(t *testing.T) {
	version := storage.GraphVersion(7)
	explainer := explainerFunc(func(_ context.Context, snapshot storage.Snapshot, request storage.ExplainRequest) (storage.Explanation, error) {
		if snapshot.Version != version {
			t.Errorf("explain snapshot version = %d, want %d", snapshot.Version, version)
		}
		if request.NodeID != "function:main" {
			t.Errorf("explained node ID = %q, want %q", request.NodeID, "function:main")
		}
		return storage.Explanation{}, nil
	})

	_, err := explainer.Explain(context.Background(), storage.Snapshot{Workspace: "workspace", Version: version}, storage.ExplainRequest{NodeID: "function:main"})
	if err != nil {
		t.Fatalf("explain node: %v", err)
	}
}

type explainerFunc func(context.Context, storage.Snapshot, storage.ExplainRequest) (storage.Explanation, error)

func (explainer explainerFunc) Explain(ctx context.Context, snapshot storage.Snapshot, request storage.ExplainRequest) (storage.Explanation, error) {
	return explainer(ctx, snapshot, request)
}

var _ storage.Explainer = explainerFunc(nil)

func TestExporterStreamsSpecifiedSnapshot(t *testing.T) {
	version := storage.GraphVersion(7)
	exporter := exporterFunc(func(_ context.Context, snapshot storage.Snapshot, _ storage.ExportRequest, _ storage.ExportSink) error {
		if snapshot.Version != version {
			t.Errorf("export snapshot version = %d, want %d", snapshot.Version, version)
		}
		return nil
	})

	err := exporter.Export(context.Background(), storage.Snapshot{Workspace: "workspace", Version: version}, storage.ExportRequest{}, discardExportSink{})
	if err != nil {
		t.Fatalf("export graph: %v", err)
	}
}

func TestEmptyExportRequestIncludesAllFacts(t *testing.T) {
	if !(storage.ExportRequest{}).IsUnfiltered() {
		t.Fatal("empty export request is filtered")
	}
}

func TestFactCounterUsesSpecifiedSnapshot(t *testing.T) {
	version := storage.GraphVersion(7)
	counter := factCounterFunc(func(_ context.Context, snapshot storage.Snapshot) (storage.FactCounts, error) {
		if snapshot.Version != version {
			t.Errorf("count snapshot version = %d, want %d", snapshot.Version, version)
		}
		return storage.FactCounts{Nodes: 2, Edges: 3}, nil
	})

	counts, err := counter.FactCounts(context.Background(), storage.Snapshot{Workspace: "workspace", Version: version})
	if err != nil {
		t.Fatalf("count facts: %v", err)
	}
	if counts != (storage.FactCounts{Nodes: 2, Edges: 3}) {
		t.Errorf("fact counts = %+v, want 2 nodes and 3 edges", counts)
	}
}

type factCounterFunc func(context.Context, storage.Snapshot) (storage.FactCounts, error)

func (counter factCounterFunc) FactCounts(ctx context.Context, snapshot storage.Snapshot) (storage.FactCounts, error) {
	return counter(ctx, snapshot)
}

var _ storage.FactCounter = factCounterFunc(nil)

type exporterFunc func(context.Context, storage.Snapshot, storage.ExportRequest, storage.ExportSink) error

func (exporter exporterFunc) Export(ctx context.Context, snapshot storage.Snapshot, request storage.ExportRequest, sink storage.ExportSink) error {
	return exporter(ctx, snapshot, request, sink)
}

var _ storage.Exporter = exporterFunc(nil)

type discardExportSink struct{}

func (discardExportSink) WriteNode(graph.Node) error {
	return nil
}

func (discardExportSink) WriteEdge(graph.Edge) error {
	return nil
}

var _ storage.ExportSink = discardExportSink{}

func TestRollbackAcceptsNamedVersion(t *testing.T) {
	version := storage.GraphVersion(7)
	rollbacker := rollbackerFunc(func(_ context.Context, request storage.RollbackRequest) (storage.Snapshot, error) {
		if request.Version != version {
			t.Errorf("rollback version = %d, want %d", request.Version, version)
		}
		return storage.Snapshot{Workspace: request.Workspace, Version: 8}, nil
	})

	snapshot, err := rollbacker.Rollback(context.Background(), storage.RollbackRequest{Workspace: "workspace", Version: version})
	if err != nil {
		t.Fatalf("rollback graph: %v", err)
	}
	if snapshot.Version != 8 {
		t.Errorf("rollback snapshot version = %d, want %d", snapshot.Version, 8)
	}
}

type rollbackerFunc func(context.Context, storage.RollbackRequest) (storage.Snapshot, error)

func (rollbacker rollbackerFunc) Rollback(ctx context.Context, request storage.RollbackRequest) (storage.Snapshot, error) {
	return rollbacker(ctx, request)
}

var _ storage.Rollbacker = rollbackerFunc(nil)

func TestPrunerAcceptsVersionRetentionBoundary(t *testing.T) {
	boundary := storage.GraphVersion(5)
	pruner := prunerFunc(func(_ context.Context, request storage.PruneRequest) (storage.PruneResult, error) {
		if request.BeforeVersion != boundary {
			t.Errorf("prune boundary = %d, want %d", request.BeforeVersion, boundary)
		}
		return storage.PruneResult{PrunedVersions: 3}, nil
	})

	result, err := pruner.Prune(context.Background(), storage.PruneRequest{Workspace: "workspace", BeforeVersion: boundary})
	if err != nil {
		t.Fatalf("prune graph versions: %v", err)
	}
	if result.PrunedVersions != 3 {
		t.Errorf("pruned versions = %d, want %d", result.PrunedVersions, 3)
	}
}

type prunerFunc func(context.Context, storage.PruneRequest) (storage.PruneResult, error)

func (pruner prunerFunc) Prune(ctx context.Context, request storage.PruneRequest) (storage.PruneResult, error) {
	return pruner(ctx, request)
}

var _ storage.Pruner = prunerFunc(nil)

func TestContractErrorsAreDistinct(t *testing.T) {
	errorsByName := map[string]error{
		"workspace": storage.ErrWorkspaceNotFound,
		"version":   storage.ErrGraphVersionNotFound,
		"pruned":    storage.ErrGraphVersionPruned,
		"request":   storage.ErrInvalidRequest,
	}
	for name, err := range errorsByName {
		if err == nil {
			t.Errorf("%s error is nil", name)
		}
		for otherName, otherErr := range errorsByName {
			if name != otherName && errors.Is(err, otherErr) {
				t.Errorf("%s error matches %s error", name, otherName)
			}
		}
	}
}

type contractStore struct {
	snapshotOpenerFunc
	publisherFunc
	affectedSourceFinderFunc
	nodeLookupFunc
	traversalFunc
	explainerFunc
	exporterFunc
	factCounterFunc
	rollbackerFunc
	prunerFunc
}

func (contractStore) SearchNodes(context.Context, storage.Snapshot, storage.LexicalSearchRequest) ([]storage.LexicalMatch, error) {
	panic("unimplemented")
}

func (contractStore) WriteCatalog(context.Context, storage.Snapshot, storage.CatalogWriteRequest) error {
	panic("unimplemented")
}

func (contractStore) WriteCatalogTask(context.Context, storage.CatalogTask) error {
	panic("unimplemented")
}

func (contractStore) ReadCatalogTask(context.Context, string) (storage.CatalogTask, bool, error) {
	panic("unimplemented")
}

func (contractStore) ReadCatalogEntries(context.Context, storage.Snapshot, storage.CatalogEntryReadRequest) ([]storage.CatalogEntry, error) {
	panic("unimplemented")
}

func (contractStore) SearchCatalog(context.Context, storage.Snapshot, storage.CatalogSearchRequest) ([]storage.CatalogMatch, error) {
	panic("unimplemented")
}

func (contractStore) DeleteCatalogEntries(context.Context, storage.Snapshot, []string) error {
	panic("unimplemented")
}

// SourceContributions implements [storage.Store].
func (c contractStore) SourceContributions(context.Context, storage.Snapshot) ([]storage.SourceContribution, error) {
	panic("unimplemented")
}

// ResolverProjections implements [storage.Store].
func (c contractStore) ResolverProjections(context.Context, storage.Snapshot) ([]storage.ResolverProjection, error) {
	panic("unimplemented")
}

// ResolverProjectionPage implements [storage.Store].
func (c contractStore) ResolverProjectionPage(context.Context, storage.Snapshot, storage.ResolverProjectionPageRequest) ([]storage.ResolverProjection, error) {
	panic("unimplemented")
}

// ResolverTarget implements [storage.Store].
func (c contractStore) ResolverTarget(context.Context, storage.Snapshot, extractor.ResolverTargetRequest) (extractor.ResolverTarget, bool, error) {
	panic("unimplemented")
}

// ResolverPackagePage implements [storage.Store].
func (c contractStore) ResolverPackagePage(context.Context, storage.Snapshot, extractor.ResolverPackagePageRequest) ([]extractor.ResolverTarget, error) {
	panic("unimplemented")
}

var _ storage.Store = contractStore{}
