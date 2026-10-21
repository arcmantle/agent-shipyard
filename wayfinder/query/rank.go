package query

import (
	"context"
	"fmt"

	"agent-wayfinder/graph"
	"agent-wayfinder/storage"
)

const maxSeedsPerTerm = 3

type ExplainResult struct {
	Candidates     []graph.Node
	RemainderCount int
	Explanation    *storage.Explanation
}

func (result ExplainResult) CandidateIDs() []string {
	return nodeIDs(result.Candidates)
}

func ExplainSnapshot(ctx context.Context, lookup storage.NodeLookup, explainer storage.Explainer, snapshot storage.Snapshot, term string) (ExplainResult, error) {
	if explainer == nil {
		return ExplainResult{}, fmt.Errorf("explain published graph: explainer is required")
	}
	if lookup == nil {
		return ExplainResult{}, fmt.Errorf("explain published graph: node lookup is required")
	}
	matches, err := lookupTermMatches(ctx, lookup, snapshot, term, maxSeedsPerTerm+1)
	if err != nil {
		return ExplainResult{}, fmt.Errorf("explain published graph: %w", err)
	}
	candidates := make([]graph.Node, len(matches))
	for index, match := range matches {
		candidates[index] = match.Node
	}
	if len(candidates) != 1 {
		return ExplainResult{
			Candidates:     candidates[:min(len(candidates), maxSeedsPerTerm)],
			RemainderCount: max(0, len(candidates)-maxSeedsPerTerm),
		}, nil
	}
	explanation, err := explainer.Explain(ctx, snapshot, storage.ExplainRequest{NodeID: candidates[0].ID})
	if err != nil {
		return ExplainResult{}, fmt.Errorf("explain published graph: %w", err)
	}
	return ExplainResult{Explanation: &explanation}, nil
}

func lookupTermMatches(ctx context.Context, lookup storage.NodeLookup, snapshot storage.Snapshot, term string, limit int) ([]storage.NodeMatch, error) {
	if exactLookup, supported := lookup.(storage.ExactNodeLookup); supported {
		matches, err := exactLookup.LookupExactNodes(ctx, snapshot, term)
		if err != nil {
			return nil, err
		}
		if len(matches) > 0 {
			return matches[:min(len(matches), limit)], nil
		}
	}
	return lookup.LookupNodes(ctx, snapshot, storage.NodeLookupRequest{Text: term, Limit: limit})
}
