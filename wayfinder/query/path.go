package query

import (
	"context"
	"fmt"
	"sort"

	"agent-wayfinder/graph"
	"agent-wayfinder/storage"
)

type PathRequest struct {
	Source                  string
	Target                  string
	AllowUndirectedFallback bool
	ProjectIDs              []string
	Relations               []graph.RelationKind
	MaxDepth                int
	MaxNodes                int
}

type PathResult struct {
	SourceCandidates     []graph.Node
	SourceRemainderCount int
	TargetCandidates     []graph.Node
	TargetRemainderCount int
	Nodes                []graph.Node
	Edges                []graph.Edge
	ScopeBoundary        *ScopeBoundary

	UsedUndirectedFallback      bool
	UndirectedFallbackAttempted bool
}

type ScopeBoundary struct {
	Node graph.Node
}

func (result PathResult) NodeIDs() []string {
	ids := make([]string, len(result.Nodes))
	for index, node := range result.Nodes {
		ids[index] = node.ID
	}
	return ids
}

func (result PathResult) SourceCandidateIDs() []string {
	return nodeIDs(result.SourceCandidates)
}

func (result PathResult) TargetCandidateIDs() []string {
	return nodeIDs(result.TargetCandidates)
}

func FindPathSnapshot(ctx context.Context, lookup storage.NodeLookup, traverser storage.Traverser, snapshot storage.Snapshot, request PathRequest) (PathResult, error) {
	if lookup == nil {
		return PathResult{}, fmt.Errorf("find published graph path: node lookup is required")
	}
	if traverser == nil {
		return PathResult{}, fmt.Errorf("find published graph path: traverser is required")
	}
	if request.Source == "" || request.Target == "" || request.MaxDepth < 0 || request.MaxNodes <= 0 {
		return PathResult{}, fmt.Errorf("find published graph path: source, target, nonnegative maximum depth, and positive maximum nodes are required")
	}

	sources, err := pathEndpointMatches(ctx, lookup, snapshot, request.Source)
	if err != nil {
		return PathResult{}, fmt.Errorf("find published graph path: %w", err)
	}
	targets, err := pathEndpointMatches(ctx, lookup, snapshot, request.Target)
	if err != nil {
		return PathResult{}, fmt.Errorf("find published graph path: %w", err)
	}
	sourceNodes := nodeMatches(sources)
	targetNodes := nodeMatches(targets)
	if len(sourceNodes) != 1 || len(targetNodes) != 1 {
		return PathResult{
			SourceCandidates:     ambiguousPathCandidates(sourceNodes),
			SourceRemainderCount: pathCandidateRemainder(sourceNodes),
			TargetCandidates:     ambiguousPathCandidates(targetNodes),
			TargetRemainderCount: pathCandidateRemainder(targetNodes),
		}, nil
	}

	traversal, err := traverser.Traverse(ctx, snapshot, storage.TraversalRequest{
		StartNodeIDs: []string{sourceNodes[0].ID},
		ProjectIDs:   append([]string(nil), request.ProjectIDs...),
		Direction:    storage.TraverseOutgoing,
		Relations:    append([]graph.RelationKind(nil), request.Relations...),
		MaxDepth:     request.MaxDepth,
		MaxNodes:     request.MaxNodes,
	})
	if err != nil {
		return PathResult{}, fmt.Errorf("find published graph path: %w", err)
	}
	result := directedPath(traversal.Facts, sourceNodes[0].ID, targetNodes[0].ID)
	if len(result.Nodes) > 0 || !request.AllowUndirectedFallback {
		return withTraversalScopeBoundary(result, traversal.ScopeBoundary), nil
	}

	fallbackTraversal, err := traverser.Traverse(ctx, snapshot, storage.TraversalRequest{
		StartNodeIDs: []string{sourceNodes[0].ID},
		ProjectIDs:   append([]string(nil), request.ProjectIDs...),
		Direction:    storage.TraverseBoth,
		Relations:    append([]graph.RelationKind(nil), request.Relations...),
		MaxDepth:     request.MaxDepth,
		MaxNodes:     request.MaxNodes,
	})
	if err != nil {
		return PathResult{}, fmt.Errorf("find published graph path fallback: %w", err)
	}
	result = undirectedPath(fallbackTraversal.Facts, sourceNodes[0].ID, targetNodes[0].ID)
	result.UndirectedFallbackAttempted = true
	result.UsedUndirectedFallback = len(result.Nodes) > 0
	return withTraversalScopeBoundary(result, fallbackTraversal.ScopeBoundary), nil
}

func pathEndpointMatches(ctx context.Context, lookup storage.NodeLookup, snapshot storage.Snapshot, endpoint string) ([]storage.NodeMatch, error) {
	if exactLookup, supported := lookup.(storage.ExactNodeLookup); supported {
		matches, err := exactLookup.LookupExactNodes(ctx, snapshot, endpoint)
		if err != nil {
			return nil, err
		}
		if len(matches) > 0 {
			return matches, nil
		}
	}
	return lookup.LookupNodes(ctx, snapshot, storage.NodeLookupRequest{Text: endpoint, Limit: maxSeedsPerTerm + 1})
}

func nodeMatches(matches []storage.NodeMatch) []graph.Node {
	nodes := make([]graph.Node, len(matches))
	for index, match := range matches {
		nodes[index] = match.Node
	}
	return nodes
}

func withTraversalScopeBoundary(result PathResult, boundary *graph.Node) PathResult {
	if len(result.Nodes) == 0 || boundary == nil {
		return result
	}
	result.ScopeBoundary = &ScopeBoundary{Node: *boundary}
	return result
}

func ambiguousPathCandidates(nodes []graph.Node) []graph.Node {
	if len(nodes) == 1 {
		return nil
	}
	return append([]graph.Node(nil), nodes[:min(len(nodes), maxSeedsPerTerm)]...)
}

func pathCandidateRemainder(nodes []graph.Node) int {
	if len(nodes) == 1 {
		return 0
	}
	return max(0, len(nodes)-maxSeedsPerTerm)
}

func nodeIDs(nodes []graph.Node) []string {
	ids := make([]string, len(nodes))
	for index, node := range nodes {
		ids[index] = node.ID
	}
	return ids
}

func directedPath(facts graph.Facts, sourceID, targetID string) PathResult {
	return shortestPath(facts, sourceID, targetID, false)
}

func undirectedPath(facts graph.Facts, sourceID, targetID string) PathResult {
	return shortestPath(facts, sourceID, targetID, true)
}

func shortestPath(facts graph.Facts, sourceID, targetID string, undirected bool) PathResult {
	nodes := make(map[string]graph.Node, len(facts.Nodes))
	for _, node := range facts.Nodes {
		nodes[node.ID] = node
	}
	if _, found := nodes[sourceID]; !found {
		return PathResult{}
	}
	if _, found := nodes[targetID]; !found {
		return PathResult{}
	}

	edgesBySource := make(map[string][]graph.Edge)
	for _, edge := range facts.Edges {
		edgesBySource[edge.SourceID] = append(edgesBySource[edge.SourceID], edge)
		if undirected {
			edgesBySource[edge.TargetID] = append(edgesBySource[edge.TargetID], edge)
		}
	}
	for source := range edgesBySource {
		sort.Slice(edgesBySource[source], func(left, right int) bool {
			return pathEdgeKey(edgesBySource[source][left]) < pathEdgeKey(edgesBySource[source][right])
		})
	}

	type predecessor struct {
		nodeID string
		edge   graph.Edge
	}
	predecessors := map[string]predecessor{}
	frontier := []string{sourceID}
	seen := map[string]struct{}{sourceID: {}}
	for len(frontier) > 0 {
		nodeID := frontier[0]
		frontier = frontier[1:]
		if nodeID == targetID {
			break
		}
		for _, edge := range edgesBySource[nodeID] {
			neighborID := edge.TargetID
			if undirected && edge.TargetID == nodeID {
				neighborID = edge.SourceID
			}
			if _, found := nodes[neighborID]; !found {
				continue
			}
			if _, found := seen[neighborID]; found {
				continue
			}
			seen[neighborID] = struct{}{}
			predecessors[neighborID] = predecessor{nodeID: nodeID, edge: edge}
			frontier = append(frontier, neighborID)
		}
	}
	if _, found := seen[targetID]; !found {
		return PathResult{}
	}

	pathNodes := []graph.Node{nodes[targetID]}
	pathEdges := make([]graph.Edge, 0)
	for nodeID := targetID; nodeID != sourceID; {
		previous := predecessors[nodeID]
		pathNodes = append(pathNodes, nodes[previous.nodeID])
		pathEdges = append(pathEdges, previous.edge)
		nodeID = previous.nodeID
	}
	reverseNodes(pathNodes)
	reverseEdges(pathEdges)
	return PathResult{Nodes: pathNodes, Edges: pathEdges}
}

func pathEdgeKey(edge graph.Edge) string {
	return edge.SourceID + "\x00" + edge.TargetID + "\x00" + string(edge.Relation)
}

func reverseNodes(nodes []graph.Node) {
	for left, right := 0, len(nodes)-1; left < right; left, right = left+1, right-1 {
		nodes[left], nodes[right] = nodes[right], nodes[left]
	}
}

func reverseEdges(edges []graph.Edge) {
	for left, right := 0, len(edges)-1; left < right; left, right = left+1, right-1 {
		edges[left], edges[right] = edges[right], edges[left]
	}
}
