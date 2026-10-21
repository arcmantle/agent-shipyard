package storage

import (
	"context"

	"agent-wayfinder/graph"
	"agent-wayfinder/query/graph_query"
)

type GraphQueryRequest struct {
	Query       graph_query.GraphQuery
	Limits      graph_query.Limits
	SeedNodeIDs []string
	Diagnostics bool
}

type GraphQueryDiagnostics struct {
	SQL        string `json:"sql"`
	Parameters []any  `json:"parameters"`
}

type GraphQueryResult struct {
	Rows        [][]any
	Facts       graph.Facts
	Truncated   bool
	Diagnostics *GraphQueryDiagnostics
}

type GraphQueryExecutor interface {
	GraphQuerySchema(context.Context, Snapshot) (graph_query.Schema, error)
	ExecuteGraphQuery(context.Context, Snapshot, GraphQueryRequest) (GraphQueryResult, error)
}
