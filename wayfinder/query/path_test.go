package query_test

import (
	"context"
	"reflect"
	"testing"

	"agent-wayfinder/graph"
	"agent-wayfinder/query"
	"agent-wayfinder/storage"
)

func TestFindPathSnapshotReturnsDirectedShortestPath(t *testing.T) {
	snapshot := storage.Snapshot{Workspace: "workspace", Version: 7}
	main := graph.Node{ID: "function:main", Label: "main", QualifiedName: "src/main.ts::main"}
	helper := graph.Node{ID: "function:helper", Label: "helper", QualifiedName: "src/helper.ts::helper"}
	edge := graph.Edge{SourceID: main.ID, TargetID: helper.ID, Relation: "calls"}
	lookup := nodeLookupFunc(func(_ context.Context, gotSnapshot storage.Snapshot, request storage.NodeLookupRequest) ([]storage.NodeMatch, error) {
		if gotSnapshot != snapshot {
			t.Errorf("lookup snapshot = %+v, want %+v", gotSnapshot, snapshot)
		}
		switch request.Text {
		case main.QualifiedName:
			return []storage.NodeMatch{{Node: main}}, nil
		case helper.QualifiedName:
			return []storage.NodeMatch{{Node: helper}}, nil
		}
		return nil, nil
	})
	traverser := traverserFunc(func(_ context.Context, gotSnapshot storage.Snapshot, request storage.TraversalRequest) (storage.TraversalResult, error) {
		if gotSnapshot != snapshot {
			t.Errorf("traversal snapshot = %+v, want %+v", gotSnapshot, snapshot)
		}
		if got, want := request.StartNodeIDs, []string{main.ID}; !reflect.DeepEqual(got, want) {
			t.Errorf("traversal start nodes = %v, want %v", got, want)
		}
		if request.Direction != storage.TraverseOutgoing {
			t.Errorf("traversal direction = %q, want outgoing", request.Direction)
		}
		if got, want := request.ProjectIDs, []string{"project:app"}; !reflect.DeepEqual(got, want) {
			t.Errorf("traversal projects = %v, want %v", got, want)
		}
		if got, want := request.Relations, []graph.RelationKind{"calls"}; !reflect.DeepEqual(got, want) {
			t.Errorf("traversal relations = %v, want %v", got, want)
		}
		if request.MaxDepth != 2 || request.MaxNodes != 3 {
			t.Errorf("traversal limits = {%d, %d}, want {2, 3}", request.MaxDepth, request.MaxNodes)
		}
		return storage.TraversalResult{Facts: graph.Facts{Nodes: []graph.Node{main, helper}, Edges: []graph.Edge{edge}}}, nil
	})

	result, err := query.FindPathSnapshot(context.Background(), lookup, traverser, snapshot, query.PathRequest{
		Source:     main.QualifiedName,
		Target:     helper.QualifiedName,
		ProjectIDs: []string{"project:app"},
		Relations:  []graph.RelationKind{"calls"},
		MaxDepth:   2,
		MaxNodes:   3,
	})
	if err != nil {
		t.Fatalf("find directed path: %v", err)
	}
	if got, want := result.NodeIDs(), []string{main.ID, helper.ID}; !reflect.DeepEqual(got, want) {
		t.Errorf("path node IDs = %v, want %v", got, want)
	}
	if got, want := result.Edges, []graph.Edge{edge}; !reflect.DeepEqual(got, want) {
		t.Errorf("path edges = %+v, want %+v", got, want)
	}
	if result.UsedUndirectedFallback {
		t.Error("path unexpectedly used undirected fallback")
	}
}

func TestFindPathSnapshotPrefersExactEndpointsOverBroadCandidates(t *testing.T) {
	snapshot := storage.Snapshot{Workspace: "workspace", Version: 7}
	indexFile := graph.Node{ID: "file:index", Label: "index.ts", QualifiedName: "core-auth/src/index.ts"}
	authInfo := graph.Node{ID: "interface:auth-info", Label: "AuthInfo", QualifiedName: "core-auth/src/auth-info.ts::AuthInfo"}
	related := graph.Node{ID: "file:related", Label: "auth-info.ts", QualifiedName: "core-login/src/auth-info.ts"}
	edge := graph.Edge{SourceID: indexFile.ID, TargetID: authInfo.ID, Relation: "typescript:re_exports"}
	lookup := exactNodeLookup{
		nodeLookupFunc: nodeLookupFunc(func(_ context.Context, _ storage.Snapshot, request storage.NodeLookupRequest) ([]storage.NodeMatch, error) {
			return []storage.NodeMatch{{Node: indexFile}, {Node: related}}, nil
		}),
		exact: func(_ context.Context, _ storage.Snapshot, identifier string) ([]storage.NodeMatch, error) {
			switch identifier {
			case "index.ts":
				return []storage.NodeMatch{{Node: indexFile}}, nil
			case authInfo.QualifiedName:
				return []storage.NodeMatch{{Node: authInfo}}, nil
			default:
				return nil, nil
			}
		},
	}
	traverser := traverserFunc(func(_ context.Context, _ storage.Snapshot, request storage.TraversalRequest) (storage.TraversalResult, error) {
		if got, want := request.StartNodeIDs, []string{indexFile.ID}; !reflect.DeepEqual(got, want) {
			t.Errorf("traversal start nodes = %v, want %v", got, want)
		}
		return storage.TraversalResult{Facts: graph.Facts{Nodes: []graph.Node{indexFile, authInfo}, Edges: []graph.Edge{edge}}}, nil
	})

	result, err := query.FindPathSnapshot(context.Background(), lookup, traverser, snapshot, query.PathRequest{
		Source:   "index.ts",
		Target:   authInfo.QualifiedName,
		MaxDepth: 1,
		MaxNodes: 3,
	})
	if err != nil {
		t.Fatalf("find path with exact endpoints: %v", err)
	}
	if got, want := result.NodeIDs(), []string{indexFile.ID, authInfo.ID}; !reflect.DeepEqual(got, want) {
		t.Errorf("path node IDs = %v, want %v", got, want)
	}
	if got, want := result.Edges, []graph.Edge{edge}; !reflect.DeepEqual(got, want) {
		t.Errorf("path edges = %+v, want %+v", got, want)
	}
}

func TestFindPathSnapshotFallsBackToBroadLookupWhenExactReturnsNoMatches(t *testing.T) {
	snapshot := storage.Snapshot{Workspace: "workspace", Version: 7}
	main := graph.Node{ID: "function:main", Label: "main", QualifiedName: "src/main.ts::main"}
	helper := graph.Node{ID: "function:helper", Label: "helper", QualifiedName: "src/helper.ts::helper"}
	edge := graph.Edge{SourceID: main.ID, TargetID: helper.ID, Relation: "calls"}
	broadLookups := 0
	lookup := exactNodeLookup{
		nodeLookupFunc: nodeLookupFunc(func(_ context.Context, _ storage.Snapshot, request storage.NodeLookupRequest) ([]storage.NodeMatch, error) {
			broadLookups++
			if request.Text == main.Label {
				return []storage.NodeMatch{{Node: main}}, nil
			}
			return []storage.NodeMatch{{Node: helper}}, nil
		}),
		exact: func(context.Context, storage.Snapshot, string) ([]storage.NodeMatch, error) {
			return nil, nil
		},
	}
	traverser := traverserFunc(func(_ context.Context, _ storage.Snapshot, request storage.TraversalRequest) (storage.TraversalResult, error) {
		if got, want := request.StartNodeIDs, []string{main.ID}; !reflect.DeepEqual(got, want) {
			t.Errorf("traversal start nodes = %v, want %v", got, want)
		}
		return storage.TraversalResult{Facts: graph.Facts{Nodes: []graph.Node{main, helper}, Edges: []graph.Edge{edge}}}, nil
	})

	result, err := query.FindPathSnapshot(context.Background(), lookup, traverser, snapshot, query.PathRequest{
		Source:   main.Label,
		Target:   helper.Label,
		MaxDepth: 1,
		MaxNodes: 3,
	})
	if err != nil {
		t.Fatalf("find path after exact lookup miss: %v", err)
	}
	if broadLookups != 2 {
		t.Errorf("broad lookups = %d, want 2", broadLookups)
	}
	if got, want := result.NodeIDs(), []string{main.ID, helper.ID}; !reflect.DeepEqual(got, want) {
		t.Errorf("path node IDs = %v, want %v", got, want)
	}
}

func TestFindPathSnapshotReturnsCandidatesForAmbiguousEndpoint(t *testing.T) {
	snapshot := storage.Snapshot{Workspace: "workspace", Version: 7}
	lookup := nodeLookupFunc(func(_ context.Context, _ storage.Snapshot, request storage.NodeLookupRequest) ([]storage.NodeMatch, error) {
		if request.Text != "helper" {
			return []storage.NodeMatch{{Node: graph.Node{ID: "function:target", Label: "target", QualifiedName: "src/target.ts::target"}}}, nil
		}
		return []storage.NodeMatch{
			{Node: graph.Node{ID: "function:a", Label: "helper", QualifiedName: "src/a.ts::helper"}},
			{Node: graph.Node{ID: "function:b", Label: "helper", QualifiedName: "src/b.ts::helper"}},
		}, nil
	})
	traverser := traverserFunc(func(context.Context, storage.Snapshot, storage.TraversalRequest) (storage.TraversalResult, error) {
		t.Fatal("traverse is called for an ambiguous path endpoint")
		return storage.TraversalResult{}, nil
	})

	result, err := query.FindPathSnapshot(context.Background(), lookup, traverser, snapshot, query.PathRequest{
		Source:   "helper",
		Target:   "target",
		MaxDepth: 2,
		MaxNodes: 3,
	})
	if err != nil {
		t.Fatalf("find ambiguous path: %v", err)
	}
	if got, want := result.SourceCandidateIDs(), []string{"function:a", "function:b"}; !reflect.DeepEqual(got, want) {
		t.Errorf("source candidate IDs = %v, want %v", got, want)
	}
	if len(result.Nodes) != 0 || len(result.Edges) != 0 {
		t.Errorf("ambiguous path = %+v, want no route", result)
	}
}

func TestFindPathSnapshotUsesUndirectedFallbackOnlyWhenRequested(t *testing.T) {
	snapshot := storage.Snapshot{Workspace: "workspace", Version: 7}
	main := graph.Node{ID: "function:main", Label: "main", QualifiedName: "src/main.ts::main"}
	helper := graph.Node{ID: "function:helper", Label: "helper", QualifiedName: "src/helper.ts::helper"}
	edge := graph.Edge{SourceID: main.ID, TargetID: helper.ID, Relation: "calls"}
	lookup := nodeLookupFunc(func(_ context.Context, _ storage.Snapshot, request storage.NodeLookupRequest) ([]storage.NodeMatch, error) {
		if request.Text == main.QualifiedName {
			return []storage.NodeMatch{{Node: main}}, nil
		}
		return []storage.NodeMatch{{Node: helper}}, nil
	})
	traverser := traverserFunc(func(_ context.Context, _ storage.Snapshot, request storage.TraversalRequest) (storage.TraversalResult, error) {
		if request.Direction != storage.TraverseBoth {
			return storage.TraversalResult{}, nil
		}
		return storage.TraversalResult{Facts: graph.Facts{Nodes: []graph.Node{main, helper}, Edges: []graph.Edge{edge}}}, nil
	})

	withoutFallback, err := query.FindPathSnapshot(context.Background(), lookup, traverser, snapshot, query.PathRequest{
		Source:   helper.QualifiedName,
		Target:   main.QualifiedName,
		MaxDepth: 2,
		MaxNodes: 3,
	})
	if err != nil {
		t.Fatalf("find directed reverse path: %v", err)
	}
	if len(withoutFallback.Nodes) != 0 {
		t.Errorf("directed reverse path = %+v, want no route", withoutFallback)
	}

	withFallback, err := query.FindPathSnapshot(context.Background(), lookup, traverser, snapshot, query.PathRequest{
		Source:                  helper.QualifiedName,
		Target:                  main.QualifiedName,
		AllowUndirectedFallback: true,
		MaxDepth:                2,
		MaxNodes:                3,
	})
	if err != nil {
		t.Fatalf("find undirected fallback path: %v", err)
	}
	if got, want := withFallback.NodeIDs(), []string{helper.ID, main.ID}; !reflect.DeepEqual(got, want) {
		t.Errorf("fallback path node IDs = %v, want %v", got, want)
	}
	if !withFallback.UsedUndirectedFallback {
		t.Error("fallback path does not report undirected use")
	}
}

func TestFindPathSnapshotReportsUnsuccessfulUndirectedFallback(t *testing.T) {
	snapshot := storage.Snapshot{Workspace: "workspace", Version: 7}
	main := graph.Node{ID: "function:main", Label: "main", QualifiedName: "src/main.ts::main"}
	isolated := graph.Node{ID: "function:isolated", Label: "isolated", QualifiedName: "src/isolated.ts::isolated"}
	lookup := nodeLookupFunc(func(_ context.Context, _ storage.Snapshot, request storage.NodeLookupRequest) ([]storage.NodeMatch, error) {
		if request.Text == main.QualifiedName {
			return []storage.NodeMatch{{Node: main}}, nil
		}
		return []storage.NodeMatch{{Node: isolated}}, nil
	})
	traversals := 0
	traverser := traverserFunc(func(_ context.Context, _ storage.Snapshot, request storage.TraversalRequest) (storage.TraversalResult, error) {
		traversals++
		return storage.TraversalResult{Facts: graph.Facts{Nodes: []graph.Node{main, isolated}}}, nil
	})

	result, err := query.FindPathSnapshot(context.Background(), lookup, traverser, snapshot, query.PathRequest{
		Source:                  main.QualifiedName,
		Target:                  isolated.QualifiedName,
		AllowUndirectedFallback: true,
		MaxDepth:                2,
		MaxNodes:                3,
	})
	if err != nil {
		t.Fatalf("find missing undirected path: %v", err)
	}
	if traversals != 2 {
		t.Errorf("traversals = %d, want directed and fallback traversals", traversals)
	}
	if len(result.Nodes) != 0 {
		t.Errorf("missing fallback path = %+v, want no route", result)
	}
	if !result.UndirectedFallbackAttempted {
		t.Error("missing fallback path does not report fallback attempt")
	}
}

func TestFindPathSnapshotReportsExternalTargetAsScopeBoundary(t *testing.T) {
	snapshot := storage.Snapshot{Workspace: "workspace", Version: 7}
	main := graph.Node{ID: "function:main", Label: "main", QualifiedName: "apps/app/src/main.ts::main"}
	helper := graph.Node{ID: "function:helper", Label: "helper", QualifiedName: "packages/library/src/helper.ts::helper"}
	lookup := nodeLookupFunc(func(_ context.Context, _ storage.Snapshot, request storage.NodeLookupRequest) ([]storage.NodeMatch, error) {
		if request.Text == main.QualifiedName {
			return []storage.NodeMatch{{Node: main}}, nil
		}
		return []storage.NodeMatch{{Node: helper}}, nil
	})
	traverser := traverserFunc(func(_ context.Context, _ storage.Snapshot, request storage.TraversalRequest) (storage.TraversalResult, error) {
		if got, want := request.ProjectIDs, []string{"project:app"}; !reflect.DeepEqual(got, want) {
			t.Errorf("traversal projects = %v, want %v", got, want)
		}
		return storage.TraversalResult{Facts: graph.Facts{
			Nodes: []graph.Node{main, helper},
			Edges: []graph.Edge{{SourceID: main.ID, TargetID: helper.ID, Relation: "calls"}},
		}, ScopeBoundary: &helper}, nil
	})

	result, err := query.FindPathSnapshot(context.Background(), lookup, traverser, snapshot, query.PathRequest{
		Source:     main.QualifiedName,
		Target:     helper.QualifiedName,
		ProjectIDs: []string{"project:app"},
		MaxDepth:   2,
		MaxNodes:   3,
	})
	if err != nil {
		t.Fatalf("find boundary path: %v", err)
	}
	if got, want := result.NodeIDs(), []string{main.ID, helper.ID}; !reflect.DeepEqual(got, want) {
		t.Errorf("boundary path node IDs = %v, want %v", got, want)
	}
	if result.ScopeBoundary == nil || result.ScopeBoundary.Node.ID != helper.ID {
		t.Errorf("scope boundary = %+v, want external helper", result.ScopeBoundary)
	}
}

type traverserFunc func(context.Context, storage.Snapshot, storage.TraversalRequest) (storage.TraversalResult, error)

func (traverser traverserFunc) Traverse(ctx context.Context, snapshot storage.Snapshot, request storage.TraversalRequest) (storage.TraversalResult, error) {
	return traverser(ctx, snapshot, request)
}

type exactNodeLookup struct {
	nodeLookupFunc
	exact func(context.Context, storage.Snapshot, string) ([]storage.NodeMatch, error)
}

func (lookup exactNodeLookup) LookupExactNodes(ctx context.Context, snapshot storage.Snapshot, identifier string) ([]storage.NodeMatch, error) {
	return lookup.exact(ctx, snapshot, identifier)
}
