package query

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"

	"agent-wayfinder/storage"
)

const (
	catalogLexicalCandidateLimit = 50
	catalogResultLimit           = 10
)

type CatalogRequest struct {
	Text string
}

type CatalogEmbeddingGenerator interface {
	GenerateCatalogEmbedding(context.Context, string) ([]float32, error)
}

type CatalogRankingOptions struct {
	EmbeddingGenerator CatalogEmbeddingGenerator
	EmbeddingReader    storage.CatalogEmbeddingReader
	VectorSearcher     storage.CatalogVectorSearcher
}

type CatalogRetrievalMethod string

const (
	CatalogRetrievalLexical              CatalogRetrievalMethod = "lexical"
	CatalogRetrievalLexicalAndEmbeddings CatalogRetrievalMethod = "lexical_and_embeddings"
	CatalogRetrievalEmbeddings           CatalogRetrievalMethod = "embeddings"
)

type CatalogRetrieval struct {
	Method              CatalogRetrievalMethod
	EmbeddingSkipReason string
}

type CatalogResult struct {
	Matches   []storage.CatalogMatch
	Retrieval CatalogRetrieval
	Warnings  []string
}

func RankCatalogSnapshot(ctx context.Context, searcher storage.CatalogSearcher, snapshot storage.Snapshot, request CatalogRequest, options CatalogRankingOptions) (CatalogResult, error) {
	if searcher == nil {
		return CatalogResult{}, fmt.Errorf("rank catalog: catalog search is required")
	}
	if strings.TrimSpace(request.Text) == "" {
		return CatalogResult{}, fmt.Errorf("rank catalog: search text is required")
	}
	matches, err := searcher.SearchCatalog(ctx, snapshot, storage.CatalogSearchRequest{Text: request.Text, Limit: catalogLexicalCandidateLimit})
	if err != nil {
		return CatalogResult{}, fmt.Errorf("rank catalog: %w", err)
	}
	matches = append([]storage.CatalogMatch(nil), matches...)
	retrieval := CatalogRetrieval{Method: CatalogRetrievalLexical, EmbeddingSkipReason: "optional embeddings are not configured"}
	if len(matches) == 0 {
		vectorMatches, reason := searchCatalogVectors(ctx, searcher, snapshot, request.Text, options)
		if len(vectorMatches) > 0 {
			if len(vectorMatches) > catalogResultLimit {
				vectorMatches = vectorMatches[:catalogResultLimit]
			}
			return CatalogResult{Matches: vectorMatches, Retrieval: CatalogRetrieval{Method: CatalogRetrievalEmbeddings}}, nil
		}
		if reason != "" {
			retrieval.EmbeddingSkipReason = reason
		} else {
			retrieval.EmbeddingSkipReason = "no catalog embeddings match the query"
		}
		return CatalogResult{
			Matches:   matches,
			Retrieval: retrieval,
			Warnings:  []string{"no catalog units match the query"},
		}, nil
	}
	if options.EmbeddingGenerator != nil && options.EmbeddingReader != nil {
		var reranked bool
		matches, reranked, retrieval.EmbeddingSkipReason = rerankCatalogMatches(ctx, matches, snapshot, request.Text, options)
		if reranked {
			retrieval.Method = CatalogRetrievalLexicalAndEmbeddings
		}
	}
	if len(matches) > catalogResultLimit {
		matches = matches[:catalogResultLimit]
	}
	return CatalogResult{
		Matches:   matches,
		Retrieval: retrieval,
	}, nil
}

func searchCatalogVectors(ctx context.Context, searcher storage.CatalogSearcher, snapshot storage.Snapshot, text string, options CatalogRankingOptions) ([]storage.CatalogMatch, string) {
	if options.EmbeddingGenerator == nil {
		return nil, "optional embeddings are not configured"
	}
	vectorSearcher := options.VectorSearcher
	if vectorSearcher == nil {
		var supported bool
		vectorSearcher, supported = searcher.(storage.CatalogVectorSearcher)
		if !supported {
			return nil, "optional vector search is unavailable"
		}
	}
	vector, err := options.EmbeddingGenerator.GenerateCatalogEmbedding(ctx, text)
	if err != nil || len(vector) == 0 {
		return nil, "optional embedding generation is unavailable"
	}
	matches, err := vectorSearcher.SearchCatalogVectors(ctx, snapshot, storage.CatalogVectorSearchRequest{Vector: vector, Limit: catalogLexicalCandidateLimit})
	if err != nil {
		return nil, "optional vector search is unavailable"
	}
	return matches, ""
}

func rerankCatalogMatches(ctx context.Context, matches []storage.CatalogMatch, snapshot storage.Snapshot, text string, options CatalogRankingOptions) ([]storage.CatalogMatch, bool, string) {
	queryVector, err := options.EmbeddingGenerator.GenerateCatalogEmbedding(ctx, text)
	if err != nil || len(queryVector) == 0 {
		return matches, false, "optional embedding generation is unavailable"
	}
	nodeIDs := make([]string, len(matches))
	for index, match := range matches {
		nodeIDs[index] = match.Node.ID
	}
	embeddings, err := options.EmbeddingReader.ReadCatalogEmbeddings(ctx, snapshot, storage.CatalogEmbeddingReadRequest{NodeIDs: nodeIDs})
	if err != nil {
		return matches, false, "optional embedding retrieval is unavailable"
	}
	scores := make(map[string]float64, len(embeddings))
	for _, embedding := range embeddings {
		score, valid := cosineSimilarity(queryVector, embedding.Vector)
		if !valid {
			continue
		}
		if prior, found := scores[embedding.NodeID]; !found || score > prior {
			scores[embedding.NodeID] = score
		}
	}
	if len(scores) == 0 {
		return matches, false, "optional catalog embeddings are unavailable"
	}
	sort.SliceStable(matches, func(left, right int) bool {
		leftScore, leftFound := scores[matches[left].Node.ID]
		rightScore, rightFound := scores[matches[right].Node.ID]
		if leftFound != rightFound {
			return leftFound
		}
		return leftFound && leftScore > rightScore
	})
	return matches, true, ""
}

func cosineSimilarity(left, right []float32) (float64, bool) {
	if len(left) == 0 || len(left) != len(right) {
		return 0, false
	}
	dotProduct := 0.0
	leftMagnitude := 0.0
	rightMagnitude := 0.0
	for index, leftValue := range left {
		rightValue := right[index]
		dotProduct += float64(leftValue * rightValue)
		leftMagnitude += float64(leftValue * leftValue)
		rightMagnitude += float64(rightValue * rightValue)
	}
	if leftMagnitude == 0 || rightMagnitude == 0 {
		return 0, false
	}
	return dotProduct / math.Sqrt(leftMagnitude*rightMagnitude), true
}
