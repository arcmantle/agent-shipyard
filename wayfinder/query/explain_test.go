package query_test

import (
	"context"
	"reflect"
	"testing"

	"agent-wayfinder/graph"
	"agent-wayfinder/query"
	"agent-wayfinder/storage"
)

func TestExplainSnapshotReturnsRankedCandidatesForAmbiguousTerm(t *testing.T) {
	snapshot := storage.Snapshot{Workspace: "workspace", Version: 7}
	lookup := nodeLookupFunc(func(_ context.Context, _ storage.Snapshot, request storage.NodeLookupRequest) ([]storage.NodeMatch, error) {
		if request.Text != "helper" || request.Limit != 4 {
			t.Errorf("lookup request = %+v, want helper with limit 4", request)
		}
		return []storage.NodeMatch{
			{Node: graph.Node{ID: "function:a", Label: "helper", QualifiedName: "src/a.ts::helper"}},
			{Node: graph.Node{ID: "function:b", Label: "helper", QualifiedName: "src/b.ts::helper"}},
			{Node: graph.Node{ID: "function:c", Label: "helper", QualifiedName: "src/c.ts::helper"}},
			{Node: graph.Node{ID: "function:d", Label: "helper", QualifiedName: "src/d.ts::helper"}},
		}, nil
	})
	explainer := explainerFunc(func(context.Context, storage.Snapshot, storage.ExplainRequest) (storage.Explanation, error) {
		t.Fatal("explain is called for an ambiguous term")
		return storage.Explanation{}, nil
	})

	result, err := query.ExplainSnapshot(context.Background(), lookup, explainer, snapshot, "helper")
	if err != nil {
		t.Fatalf("explain snapshot: %v", err)
	}
	if got, want := result.CandidateIDs(), []string{"function:a", "function:b", "function:c"}; !reflect.DeepEqual(got, want) {
		t.Errorf("candidate IDs = %v, want %v", got, want)
	}
	if result.RemainderCount != 1 {
		t.Errorf("candidate remainder count = %d, want 1", result.RemainderCount)
	}
	if result.Explanation != nil {
		t.Errorf("explanation = %+v, want nil for an ambiguous term", result.Explanation)
	}
}

func TestExplainSnapshotCallsExplainerForSingleMatch(t *testing.T) {
	snapshot := storage.Snapshot{Workspace: "workspace", Version: 7}
	node := graph.Node{ID: "function:helper", Label: "helper", QualifiedName: "src/helper.ts::helper"}
	lookup := nodeLookupFunc(func(_ context.Context, _ storage.Snapshot, request storage.NodeLookupRequest) ([]storage.NodeMatch, error) {
		if request.Text != "helper" || request.Limit != 4 {
			t.Errorf("lookup request = %+v, want helper with limit 4", request)
		}
		return []storage.NodeMatch{{Node: node}}, nil
	})
	expected := storage.Explanation{
		Node:            node,
		SupportingFacts: graph.Facts{Edges: []graph.Edge{{SourceID: "function:main", TargetID: node.ID}}},
	}
	explainer := explainerFunc(func(_ context.Context, gotSnapshot storage.Snapshot, request storage.ExplainRequest) (storage.Explanation, error) {
		if gotSnapshot != snapshot {
			t.Errorf("explainer snapshot = %+v, want %+v", gotSnapshot, snapshot)
		}
		if request.NodeID != node.ID {
			t.Errorf("explained node ID = %q, want %q", request.NodeID, node.ID)
		}
		return expected, nil
	})

	result, err := query.ExplainSnapshot(context.Background(), lookup, explainer, snapshot, "helper")
	if err != nil {
		t.Fatalf("explain snapshot: %v", err)
	}
	if result.Explanation == nil || !reflect.DeepEqual(*result.Explanation, expected) {
		t.Errorf("explanation = %+v, want %+v", result.Explanation, expected)
	}
	if len(result.Candidates) != 0 {
		t.Errorf("candidates = %+v, want none for a selected node", result.Candidates)
	}
}

type explainerFunc func(context.Context, storage.Snapshot, storage.ExplainRequest) (storage.Explanation, error)

func (explainer explainerFunc) Explain(ctx context.Context, snapshot storage.Snapshot, request storage.ExplainRequest) (storage.Explanation, error) {
	return explainer(ctx, snapshot, request)
}

type nodeLookupFunc func(context.Context, storage.Snapshot, storage.NodeLookupRequest) ([]storage.NodeMatch, error)

func (lookup nodeLookupFunc) LookupNodes(ctx context.Context, snapshot storage.Snapshot, request storage.NodeLookupRequest) ([]storage.NodeMatch, error) {
	return lookup(ctx, snapshot, request)
}

func nodeIDs(nodes []graph.Node) []string {
	ids := make([]string, len(nodes))
	for index, node := range nodes {
		ids[index] = node.ID
	}
	return ids
}
