package query_test

import (
	"context"
	"fmt"
	"reflect"
	"testing"

	"agent-wayfinder/graph"
	"agent-wayfinder/query"
	"agent-wayfinder/storage"
)

type catalogSearcherFunc func(context.Context, storage.Snapshot, storage.CatalogSearchRequest) ([]storage.CatalogMatch, error)

func (search catalogSearcherFunc) SearchCatalog(ctx context.Context, snapshot storage.Snapshot, request storage.CatalogSearchRequest) ([]storage.CatalogMatch, error) {
	return search(ctx, snapshot, request)
}

func TestRankCatalogSnapshotReturnsTenLexicalMatches(t *testing.T) {
	snapshot := storage.Snapshot{Workspace: "workspace", Version: 7}
	matches := make([]storage.CatalogMatch, 12)
	for index := range matches {
		matches[index] = storage.CatalogMatch{
			Node:  graph.Node{ID: fmt.Sprintf("function:%02d", index)},
			Entry: storage.CatalogEntry{NodeID: fmt.Sprintf("function:%02d", index), Name: fmt.Sprintf("Function%02d", index)},
			Score: float64(len(matches) - index),
		}
	}
	searcher := catalogSearcherFunc(func(_ context.Context, gotSnapshot storage.Snapshot, request storage.CatalogSearchRequest) ([]storage.CatalogMatch, error) {
		if gotSnapshot != snapshot {
			t.Errorf("snapshot = %+v, want %+v", gotSnapshot, snapshot)
		}
		if request != (storage.CatalogSearchRequest{Text: "validate access token", Limit: 50}) {
			t.Errorf("catalog request = %+v, want text with limit 50", request)
		}
		return matches, nil
	})

	result, err := query.RankCatalogSnapshot(context.Background(), searcher, snapshot, query.CatalogRequest{Text: "validate access token"}, query.CatalogRankingOptions{})
	if err != nil {
		t.Fatalf("rank catalog snapshot: %v", err)
	}
	if got, want := catalogNodeIDs(result.Matches), catalogNodeIDs(matches[:10]); !reflect.DeepEqual(got, want) {
		t.Errorf("catalog match IDs = %v, want %v", got, want)
	}
	if result.Retrieval.Method != query.CatalogRetrievalLexical || result.Retrieval.EmbeddingSkipReason == "" {
		t.Errorf("catalog retrieval = %+v, want lexical retrieval with an embedding skip reason", result.Retrieval)
	}
}

type catalogEmbeddingReaderFunc func(context.Context, storage.Snapshot, storage.CatalogEmbeddingReadRequest) ([]storage.CatalogEmbedding, error)

func (read catalogEmbeddingReaderFunc) ReadCatalogEmbeddings(ctx context.Context, snapshot storage.Snapshot, request storage.CatalogEmbeddingReadRequest) ([]storage.CatalogEmbedding, error) {
	return read(ctx, snapshot, request)
}

type catalogVectorSearcherFunc func(context.Context, storage.Snapshot, storage.CatalogVectorSearchRequest) ([]storage.CatalogMatch, error)

func (search catalogVectorSearcherFunc) SearchCatalogVectors(ctx context.Context, snapshot storage.Snapshot, request storage.CatalogVectorSearchRequest) ([]storage.CatalogMatch, error) {
	return search(ctx, snapshot, request)
}

type catalogEmbeddingGeneratorFunc func(context.Context, string) ([]float32, error)

func (generate catalogEmbeddingGeneratorFunc) GenerateCatalogEmbedding(ctx context.Context, text string) ([]float32, error) {
	return generate(ctx, text)
}

func TestRankCatalogSnapshotReranksLexicalCandidatesWithEmbeddings(t *testing.T) {
	snapshot := storage.Snapshot{Workspace: "workspace", Version: 7}
	matches := []storage.CatalogMatch{
		{Node: graph.Node{ID: "function:lexical-first"}, Entry: storage.CatalogEntry{NodeID: "function:lexical-first", Name: "LexicalFirst"}, Score: 2},
		{Node: graph.Node{ID: "function:embedding-first"}, Entry: storage.CatalogEntry{NodeID: "function:embedding-first", Name: "EmbeddingFirst"}, Score: 1},
	}
	searcher := catalogSearcherFunc(func(context.Context, storage.Snapshot, storage.CatalogSearchRequest) ([]storage.CatalogMatch, error) {
		return matches, nil
	})
	reader := catalogEmbeddingReaderFunc(func(_ context.Context, gotSnapshot storage.Snapshot, request storage.CatalogEmbeddingReadRequest) ([]storage.CatalogEmbedding, error) {
		if gotSnapshot != snapshot || !reflect.DeepEqual(request.NodeIDs, []string{"function:lexical-first", "function:embedding-first"}) {
			t.Errorf("embedding request = {%+v, %+v}, want snapshot and lexical candidate IDs", gotSnapshot, request)
		}
		return []storage.CatalogEmbedding{
			{NodeID: "function:embedding-first", Source: storage.CatalogEmbeddingDeterministic, Vector: []float32{1, 0}},
		}, nil
	})
	generator := catalogEmbeddingGeneratorFunc(func(_ context.Context, text string) ([]float32, error) {
		if text != "validate access token" {
			t.Errorf("embedding text = %q, want capability query", text)
		}
		return []float32{1, 0}, nil
	})

	result, err := query.RankCatalogSnapshot(context.Background(), searcher, snapshot, query.CatalogRequest{Text: "validate access token"}, query.CatalogRankingOptions{EmbeddingReader: reader, EmbeddingGenerator: generator})
	if err != nil {
		t.Fatalf("rank catalog snapshot: %v", err)
	}
	if got, want := catalogNodeIDs(result.Matches), []string{"function:embedding-first", "function:lexical-first"}; !reflect.DeepEqual(got, want) {
		t.Errorf("catalog match IDs = %v, want %v", got, want)
	}
	if result.Retrieval.Method != query.CatalogRetrievalLexicalAndEmbeddings || result.Retrieval.EmbeddingSkipReason != "" {
		t.Errorf("catalog retrieval = %+v, want lexical and embedding retrieval", result.Retrieval)
	}
}

func TestRankCatalogSnapshotReportsNoLexicalMatchesWithoutEmbeddingSearch(t *testing.T) {
	searcher := catalogSearcherFunc(func(context.Context, storage.Snapshot, storage.CatalogSearchRequest) ([]storage.CatalogMatch, error) {
		return nil, nil
	})
	reader := catalogEmbeddingReaderFunc(func(context.Context, storage.Snapshot, storage.CatalogEmbeddingReadRequest) ([]storage.CatalogEmbedding, error) {
		t.Fatal("embedding reader is called without lexical catalog matches")
		return nil, nil
	})
	generator := catalogEmbeddingGeneratorFunc(func(context.Context, string) ([]float32, error) {
		t.Fatal("embedding generator is called without lexical catalog matches")
		return nil, nil
	})

	result, err := query.RankCatalogSnapshot(context.Background(), searcher, storage.Snapshot{Workspace: "workspace", Version: 7}, query.CatalogRequest{Text: "rotate service credential"}, query.CatalogRankingOptions{EmbeddingReader: reader, EmbeddingGenerator: generator})
	if err != nil {
		t.Fatalf("rank catalog snapshot: %v", err)
	}
	if len(result.Matches) != 0 || len(result.Warnings) != 1 || result.Retrieval.Method != query.CatalogRetrievalLexical || result.Retrieval.EmbeddingSkipReason == "" {
		t.Errorf("catalog result = %+v, want an empty lexical result with a warning and embedding skip reason", result)
	}
}

func TestRankCatalogSnapshotUsesVectorSearchWithoutLexicalMatches(t *testing.T) {
	snapshot := storage.Snapshot{Workspace: "workspace", Version: 7}
	searcher := catalogSearcherFunc(func(context.Context, storage.Snapshot, storage.CatalogSearchRequest) ([]storage.CatalogMatch, error) {
		return nil, nil
	})
	vectorSearcher := catalogVectorSearcherFunc(func(_ context.Context, gotSnapshot storage.Snapshot, request storage.CatalogVectorSearchRequest) ([]storage.CatalogMatch, error) {
		if gotSnapshot != snapshot || request.Limit != 50 || !reflect.DeepEqual(request.Vector, []float32{1, 0}) {
			t.Errorf("vector request = {%+v, %+v}, want snapshot and query vector", gotSnapshot, request)
		}
		return []storage.CatalogMatch{{Node: graph.Node{ID: "function:rotateCredential"}, Entry: storage.CatalogEntry{NodeID: "function:rotateCredential"}}}, nil
	})
	result, err := query.RankCatalogSnapshot(context.Background(), searcher, snapshot, query.CatalogRequest{Text: "rotate service credential"}, query.CatalogRankingOptions{
		EmbeddingGenerator: catalogEmbeddingGeneratorFunc(func(context.Context, string) ([]float32, error) { return []float32{1, 0}, nil }),
		VectorSearcher:     vectorSearcher,
	})
	if err != nil {
		t.Fatalf("rank catalog snapshot: %v", err)
	}
	if got, want := catalogNodeIDs(result.Matches), []string{"function:rotateCredential"}; !reflect.DeepEqual(got, want) {
		t.Errorf("catalog match IDs = %v, want %v", got, want)
	}
	if result.Retrieval.Method != query.CatalogRetrievalEmbeddings || result.Retrieval.EmbeddingSkipReason != "" || len(result.Warnings) != 0 {
		t.Errorf("catalog result = %+v, want vector retrieval without warnings", result)
	}
}

func TestRankCatalogSnapshotRejectsInvalidRequests(t *testing.T) {
	searcher := catalogSearcherFunc(func(context.Context, storage.Snapshot, storage.CatalogSearchRequest) ([]storage.CatalogMatch, error) {
		t.Fatal("catalog search is called for an invalid request")
		return nil, nil
	})
	for _, testCase := range []struct {
		name     string
		searcher storage.CatalogSearcher
		request  query.CatalogRequest
	}{
		{name: "missing searcher", request: query.CatalogRequest{Text: "validate token"}},
		{name: "empty text", searcher: searcher, request: query.CatalogRequest{Text: " \t"}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := query.RankCatalogSnapshot(context.Background(), testCase.searcher, storage.Snapshot{Workspace: "workspace", Version: 7}, testCase.request, query.CatalogRankingOptions{}); err == nil {
				t.Error("rank catalog snapshot error = nil, want invalid request error")
			}
		})
	}
}

func TestRankCatalogSnapshotKeepsLexicalMatchesWhenEmbeddingsAreUnavailable(t *testing.T) {
	matches := []storage.CatalogMatch{
		{Node: graph.Node{ID: "function:one"}, Entry: storage.CatalogEntry{NodeID: "function:one"}},
		{Node: graph.Node{ID: "function:two"}, Entry: storage.CatalogEntry{NodeID: "function:two"}},
	}
	searcher := catalogSearcherFunc(func(context.Context, storage.Snapshot, storage.CatalogSearchRequest) ([]storage.CatalogMatch, error) {
		return matches, nil
	})
	for _, testCase := range []struct {
		name    string
		options query.CatalogRankingOptions
	}{
		{
			name: "generation error",
			options: query.CatalogRankingOptions{
				EmbeddingGenerator: catalogEmbeddingGeneratorFunc(func(context.Context, string) ([]float32, error) { return nil, fmt.Errorf("model unavailable") }),
				EmbeddingReader: catalogEmbeddingReaderFunc(func(context.Context, storage.Snapshot, storage.CatalogEmbeddingReadRequest) ([]storage.CatalogEmbedding, error) {
					t.Fatal("embedding reader is called after embedding generation fails")
					return nil, nil
				}),
			},
		},
		{
			name: "read error",
			options: query.CatalogRankingOptions{
				EmbeddingGenerator: catalogEmbeddingGeneratorFunc(func(context.Context, string) ([]float32, error) { return []float32{1, 0}, nil }),
				EmbeddingReader: catalogEmbeddingReaderFunc(func(context.Context, storage.Snapshot, storage.CatalogEmbeddingReadRequest) ([]storage.CatalogEmbedding, error) {
					return nil, fmt.Errorf("vectors unavailable")
				}),
			},
		},
		{
			name: "invalid vectors",
			options: query.CatalogRankingOptions{
				EmbeddingGenerator: catalogEmbeddingGeneratorFunc(func(context.Context, string) ([]float32, error) { return []float32{1, 0}, nil }),
				EmbeddingReader: catalogEmbeddingReaderFunc(func(context.Context, storage.Snapshot, storage.CatalogEmbeddingReadRequest) ([]storage.CatalogEmbedding, error) {
					return []storage.CatalogEmbedding{{NodeID: "function:one", Vector: []float32{1}}}, nil
				}),
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			result, err := query.RankCatalogSnapshot(context.Background(), searcher, storage.Snapshot{Workspace: "workspace", Version: 7}, query.CatalogRequest{Text: "validate access token"}, testCase.options)
			if err != nil {
				t.Fatalf("rank catalog snapshot: %v", err)
			}
			if got, want := catalogNodeIDs(result.Matches), catalogNodeIDs(matches); !reflect.DeepEqual(got, want) {
				t.Errorf("catalog match IDs = %v, want %v", got, want)
			}
			if result.Retrieval.Method != query.CatalogRetrievalLexical || result.Retrieval.EmbeddingSkipReason == "" {
				t.Errorf("catalog retrieval = %+v, want lexical retrieval with an embedding skip reason", result.Retrieval)
			}
		})
	}
}

func catalogNodeIDs(matches []storage.CatalogMatch) []string {
	identifiers := make([]string, len(matches))
	for index, match := range matches {
		identifiers[index] = match.Node.ID
	}
	return identifiers
}
