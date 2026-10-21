package benchmark

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"time"

	"agent-wayfinder/graph"
	"agent-wayfinder/storage"
)

type LiteralSearchResult struct {
	Candidates        []graph.Node
	Facts             graph.Facts
	TruncationReasons []storage.TruncationReason
	ObservedIntent    QuestionIntent
}

type LiteralSearchExecutor func(context.Context, ArchitectureQuestion) (LiteralSearchResult, error)

func NewLiteralQueryExecutor(lookup storage.NodeLookup, traverser storage.Traverser, snapshot storage.Snapshot, maxDepth, maxNodes int) LiteralSearchExecutor {
	return func(ctx context.Context, question ArchitectureQuestion) (LiteralSearchResult, error) {
		if lookup == nil || traverser == nil || snapshot.Workspace == "" || snapshot.Version == 0 || maxDepth < 0 || maxNodes <= 0 {
			return LiteralSearchResult{}, fmt.Errorf("execute literal query baseline: lookup, traverser, snapshot, and valid limits are required")
		}
		candidates, err := literalCandidates(ctx, lookup, snapshot, question.Text)
		if err != nil {
			return LiteralSearchResult{}, fmt.Errorf("execute literal query baseline: %w", err)
		}
		if len(candidates) == 0 {
			return LiteralSearchResult{Candidates: candidates}, nil
		}
		startNodeIDs := make([]string, len(candidates))
		for index, candidate := range candidates {
			startNodeIDs[index] = candidate.ID
		}
		result, err := traverser.Traverse(ctx, snapshot, storage.TraversalRequest{
			StartNodeIDs: startNodeIDs,
			Direction:    storage.TraverseOutgoing,
			MaxDepth:     maxDepth,
			MaxNodes:     maxNodes,
		})
		if err != nil {
			return LiteralSearchResult{}, fmt.Errorf("execute literal query baseline: %w", err)
		}
		return LiteralSearchResult{
			Candidates:        candidates,
			Facts:             result.Facts,
			TruncationReasons: result.TruncationReasons,
		}, nil
	}
}

func literalCandidates(ctx context.Context, lookup storage.NodeLookup, snapshot storage.Snapshot, text string) ([]graph.Node, error) {
	var matches []storage.NodeMatch
	var err error
	if exactLookup, supported := lookup.(storage.ExactNodeLookup); supported {
		matches, err = exactLookup.LookupExactNodes(ctx, snapshot, text)
		if err != nil {
			return nil, err
		}
	}
	if len(matches) == 0 {
		matches, err = lookup.LookupNodes(ctx, snapshot, storage.NodeLookupRequest{Text: text, Limit: 10})
		if err != nil {
			return nil, err
		}
	}
	matches = matches[:min(len(matches), 10)]
	candidates := make([]graph.Node, len(matches))
	for index, match := range matches {
		candidates[index] = match.Node
	}
	return candidates, nil
}

type QuestionBaselineResult struct {
	Question          string                     `json:"question"`
	ExpectedIntent    QuestionIntent             `json:"expectedIntent"`
	ObservedIntent    QuestionIntent             `json:"observedIntent,omitempty"`
	CandidateIDs      []string                   `json:"candidateIds"`
	CandidatePaths    []string                   `json:"candidatePaths"`
	Relations         []graph.RelationKind       `json:"relations"`
	TruncationReasons []storage.TruncationReason `json:"truncationReasons,omitempty"`
	RecallAt10Hit     bool                       `json:"recallAt10Hit"`
	OutputHash        string                     `json:"outputHash"`
}

type QuestionBaseline struct {
	Results            []QuestionBaselineResult `json:"results"`
	RecallAt10         float64                  `json:"recallAt10"`
	IntentAccuracy     float64                  `json:"intentAccuracy"`
	P50Latency         time.Duration            `json:"p50Latency"`
	P95Latency         time.Duration            `json:"p95Latency"`
	SeedDiversity      float64                  `json:"seedDiversity"`
	TruncatedQuestions int                      `json:"truncatedQuestions"`
	OutputHash         string                   `json:"outputHash"`
}

func RunLiteralSearchBaseline(ctx context.Context, questions []ArchitectureQuestion, execute LiteralSearchExecutor, now func() time.Time) (QuestionBaseline, error) {
	if len(questions) == 0 || execute == nil || now == nil {
		return QuestionBaseline{}, fmt.Errorf("run literal-search baseline: questions, executor, and clock are required")
	}

	report := QuestionBaseline{Results: make([]QuestionBaselineResult, 0, len(questions))}
	latencies := make([]time.Duration, 0, len(questions))
	recallHits := 0
	intentHits := 0
	seedCount := 0
	seedPaths := make(map[string]struct{})
	for _, question := range questions {
		startedAt := now()
		searchResult, err := execute(ctx, question)
		latency := now().Sub(startedAt)
		if err != nil {
			return QuestionBaseline{}, fmt.Errorf("run literal-search baseline for %q: %w", question.Text, err)
		}
		latencies = append(latencies, latency)

		result := baselineQuestionResult(question, searchResult)
		if result.RecallAt10Hit {
			recallHits++
		}
		if result.ObservedIntent != "" && result.ObservedIntent == result.ExpectedIntent {
			intentHits++
		}
		if len(result.TruncationReasons) > 0 {
			report.TruncatedQuestions++
		}
		for _, candidate := range searchResult.Candidates {
			seedCount++
			seedPaths[candidate.Evidence.Span.Path] = struct{}{}
		}
		report.Results = append(report.Results, result)
	}

	report.RecallAt10 = float64(recallHits) / float64(len(questions))
	report.IntentAccuracy = float64(intentHits) / float64(len(questions))
	report.P50Latency = percentileDuration(latencies, 0.50)
	report.P95Latency = percentileDuration(latencies, 0.95)
	if seedCount > 0 {
		report.SeedDiversity = float64(len(seedPaths)) / float64(seedCount)
	}
	report.OutputHash = hashStableValue(struct {
		Results            []QuestionBaselineResult `json:"results"`
		RecallAt10         float64                  `json:"recallAt10"`
		IntentAccuracy     float64                  `json:"intentAccuracy"`
		SeedDiversity      float64                  `json:"seedDiversity"`
		TruncatedQuestions int                      `json:"truncatedQuestions"`
	}{report.Results, report.RecallAt10, report.IntentAccuracy, report.SeedDiversity, report.TruncatedQuestions})
	return report, nil
}

func baselineQuestionResult(question ArchitectureQuestion, searchResult LiteralSearchResult) QuestionBaselineResult {
	result := QuestionBaselineResult{
		Question:          question.Text,
		ExpectedIntent:    question.Intent,
		ObservedIntent:    searchResult.ObservedIntent,
		CandidateIDs:      make([]string, 0, len(searchResult.Candidates)),
		CandidatePaths:    make([]string, 0, len(searchResult.Candidates)),
		TruncationReasons: append([]storage.TruncationReason(nil), searchResult.TruncationReasons...),
	}
	for _, candidate := range searchResult.Candidates {
		result.CandidateIDs = append(result.CandidateIDs, candidate.ID)
		result.CandidatePaths = append(result.CandidatePaths, candidate.Evidence.Span.Path)
	}
	relationSet := make(map[graph.RelationKind]struct{})
	for _, edge := range searchResult.Facts.Edges {
		relationSet[edge.Relation] = struct{}{}
	}
	for relation := range relationSet {
		result.Relations = append(result.Relations, relation)
	}
	sort.Slice(result.Relations, func(left, right int) bool { return result.Relations[left] < result.Relations[right] })
	result.RecallAt10Hit = recallAt10Hit(question, searchResult.Candidates)
	result.OutputHash = hashStableValue(struct {
		QuestionBaselineResult
		OutputHash string `json:"outputHash,omitempty"`
	}{QuestionBaselineResult: result})
	return result
}

func recallAt10Hit(question ArchitectureQuestion, candidates []graph.Node) bool {
	if question.NoMatch {
		return len(candidates) == 0
	}
	for _, candidate := range candidates[:min(len(candidates), 10)] {
		for _, acceptable := range question.AcceptableSeeds {
			if candidate.ID == acceptable || candidate.Label == acceptable || candidate.QualifiedName == acceptable {
				return true
			}
		}
		for _, acceptable := range question.AcceptablePaths {
			if candidate.Evidence.Span.Path == acceptable {
				return true
			}
		}
	}
	return false
}

func percentileDuration(values []time.Duration, percentile float64) time.Duration {
	ordered := append([]time.Duration(nil), values...)
	sort.Slice(ordered, func(left, right int) bool { return ordered[left] < ordered[right] })
	index := int(math.Ceil(percentile*float64(len(ordered)))) - 1
	return ordered[max(0, index)]
}

func hashStableValue(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(fmt.Sprintf("marshal stable benchmark value: %v", err))
	}
	hash := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(hash[:])
}
