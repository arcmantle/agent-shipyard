package query

import (
	"context"
	"fmt"

	"agent-wayfinder/graph"
	"agent-wayfinder/query/graph_query"
	"agent-wayfinder/storage"
)

type GraphQuery = graph_query.GraphQuery
type MatchClause = graph_query.MatchClause
type NodePattern = graph_query.NodePattern
type RelationshipPattern = graph_query.RelationshipPattern
type PropertyPredicate = graph_query.PropertyPredicate
type Projection = graph_query.Projection
type SearchKind = graph_query.SearchKind
type SearchClause = graph_query.SearchClause
type OrderTerm = graph_query.OrderTerm
type GraphQuerySchema = graph_query.Schema
type GraphQueryLimits = graph_query.Limits

const (
	SearchLexical = graph_query.SearchLexical
	SearchVector  = graph_query.SearchVector
)

// ParseGraphQuery parses a constrained graph-query source string.
func ParseGraphQuery(source string) (GraphQuery, error) {
	return graph_query.Parse(source)
}

func ValidateGraphQuery(parsed GraphQuery, schema GraphQuerySchema, limits GraphQueryLimits) (GraphQuery, error) {
	return graph_query.Validate(parsed, schema, limits)
}

type GraphQueryOptions struct {
	EmbeddingGenerator CatalogEmbeddingGenerator
	Diagnostics        bool
}

type GraphQueryResult struct {
	Snapshot    storage.Snapshot               `json:"snapshot"`
	Graph       graph.Facts                    `json:"graph"`
	Rows        [][]any                        `json:"rows"`
	Evidence    []graph.FactEvidence           `json:"evidence"`
	Warnings    []string                       `json:"warnings"`
	Limits      GraphQueryLimits               `json:"limits"`
	Diagnostics *storage.GraphQueryDiagnostics `json:"diagnostics,omitempty"`
}

func ExecuteGraphQuerySnapshot(ctx context.Context, executor storage.GraphQueryExecutor, snapshot storage.Snapshot, parsed GraphQuery, limits GraphQueryLimits, options GraphQueryOptions) (GraphQueryResult, error) {
	if executor == nil {
		return GraphQueryResult{}, fmt.Errorf("execute graph query: executor is required")
	}
	schema, err := executor.GraphQuerySchema(ctx, snapshot)
	if err != nil {
		return GraphQueryResult{}, err
	}
	validated, err := ValidateGraphQuery(parsed, schema, limits)
	if err != nil {
		return GraphQueryResult{}, err
	}
	var seeds []string
	if validated.Search != nil {
		seeds, err = graphQuerySearchSeeds(ctx, executor, snapshot, *validated.Search, limits.MaxNodes, options)
		if err != nil {
			return GraphQueryResult{}, err
		}
	}
	executed, err := executor.ExecuteGraphQuery(ctx, snapshot, storage.GraphQueryRequest{Query: validated, Limits: limits, SeedNodeIDs: seeds, Diagnostics: options.Diagnostics})
	if err != nil {
		return GraphQueryResult{}, err
	}
	result := GraphQueryResult{Snapshot: snapshot, Graph: executed.Facts, Rows: executed.Rows, Limits: limits, Evidence: []graph.FactEvidence{}, Warnings: []string{}}
	result.Diagnostics = executed.Diagnostics
	for _, node := range result.Graph.Nodes {
		result.Evidence = append(result.Evidence, node.Evidence)
	}
	for _, edge := range result.Graph.Edges {
		result.Evidence = append(result.Evidence, edge.Evidence)
	}
	if executed.Truncated {
		result.Warnings = append(result.Warnings, "graph query reached a result or node limit")
	}
	return result, nil
}

func graphQuerySearchSeeds(ctx context.Context, executor storage.GraphQueryExecutor, snapshot storage.Snapshot, search SearchClause, limit int, options GraphQueryOptions) ([]string, error) {
	var matches []storage.CatalogMatch
	var err error
	if search.Kind == SearchLexical {
		searcher, supported := executor.(storage.CatalogSearcher)
		if !supported {
			return nil, fmt.Errorf("execute graph query: lexical catalog search is unavailable")
		}
		matches, err = searcher.SearchCatalog(ctx, snapshot, storage.CatalogSearchRequest{Text: search.Text, Limit: limit})
	} else {
		if options.EmbeddingGenerator == nil {
			return nil, fmt.Errorf("execute graph query: vector SEARCH requires an embedding generator")
		}
		searcher, supported := executor.(storage.CatalogVectorSearcher)
		if !supported {
			return nil, fmt.Errorf("execute graph query: vector catalog search is unavailable")
		}
		var vector []float32
		vector, err = options.EmbeddingGenerator.GenerateCatalogEmbedding(ctx, search.Text)
		if err == nil {
			matches, err = searcher.SearchCatalogVectors(ctx, snapshot, storage.CatalogVectorSearchRequest{Vector: vector, Limit: limit})
		}
	}
	if err != nil {
		return nil, fmt.Errorf("execute graph query SEARCH: %w", err)
	}
	seeds := make([]string, 0, min(limit, len(matches)))
	for _, match := range matches[:min(limit, len(matches))] {
		seeds = append(seeds, match.Node.ID)
	}
	return seeds, nil
}
