package benchmark_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"agent-wayfinder/benchmark"
	"agent-wayfinder/graph"
	"agent-wayfinder/index"
	"agent-wayfinder/storage"
	"agent-wayfinder/storage/sqlite"
)

func TestArchitectureQuestionCorpusCoversFirstReleaseContract(t *testing.T) {
	questions := benchmark.ArchitectureQuestions()
	if len(questions) != 30 {
		t.Fatalf("architecture question count = %d, want 30", len(questions))
	}

	wantedIntents := map[benchmark.QuestionIntent]bool{
		benchmark.IntentLookup:         false,
		benchmark.IntentExplain:        false,
		benchmark.IntentCalls:          false,
		benchmark.IntentCalledBy:       false,
		benchmark.IntentDependencies:   false,
		benchmark.IntentDependents:     false,
		benchmark.IntentPath:           false,
		benchmark.IntentReachability:   false,
		benchmark.IntentSharedContract: false,
		benchmark.IntentImpact:         false,
	}
	var foundReportedQuestion bool
	var foundNoMatch bool
	for _, question := range questions {
		if question.Text == "" || len(question.EntityRoles) == 0 {
			t.Errorf("question = %+v, want text and entity roles", question)
		}
		if len(question.AcceptableSeeds) == 0 && len(question.AcceptablePaths) == 0 && !question.NoMatch {
			t.Errorf("question %q has no acceptable evidence", question.Text)
		}
		if len(question.RequiredRelations) == 0 && question.Intent != benchmark.IntentLookup && question.Intent != benchmark.IntentExplain && !question.NoMatch {
			t.Errorf("question %q has no required relations", question.Text)
		}
		if len(question.ForbiddenClaims) == 0 {
			t.Errorf("question %q has no forbidden claims", question.Text)
		}
		if _, found := wantedIntents[question.Intent]; !found {
			t.Errorf("question %q has unsupported intent %q", question.Text, question.Intent)
		} else {
			wantedIntents[question.Intent] = true
		}
		foundReportedQuestion = foundReportedQuestion || question.Text == "what is the shared contract between postgres and sqlite"
		foundNoMatch = foundNoMatch || question.NoMatch
	}
	for intent, found := range wantedIntents {
		if !found {
			t.Errorf("corpus does not cover intent %q", intent)
		}
	}
	if !foundReportedQuestion {
		t.Error("corpus does not contain the reported shared-contract question")
	}
	if !foundNoMatch {
		t.Error("corpus does not contain a no-match question")
	}
}

func TestArchitectureQuestionCorpusRecordsRequiredInputForms(t *testing.T) {
	wantedFeatures := map[benchmark.QuestionFeature]bool{
		benchmark.FeatureAlias:        false,
		benchmark.FeatureCamelCase:    false,
		benchmark.FeatureSnakeCase:    false,
		benchmark.FeaturePackageName:  false,
		benchmark.FeatureFileName:     false,
		benchmark.FeatureQuotedSymbol: false,
		benchmark.FeaturePlural:       false,
		benchmark.FeatureFillerWords:  false,
		benchmark.FeatureNoMatch:      false,
	}
	for _, question := range benchmark.ArchitectureQuestions() {
		for _, feature := range question.Features {
			if _, found := wantedFeatures[feature]; found {
				wantedFeatures[feature] = true
			}
		}
	}
	for feature, found := range wantedFeatures {
		if !found {
			t.Errorf("corpus does not cover input feature %q", feature)
		}
	}
}

func TestRunLiteralSearchBaselineRecordsMetricsAndStableHashes(t *testing.T) {
	questions := benchmark.ArchitectureQuestions()
	execute := func(_ context.Context, question benchmark.ArchitectureQuestion) (benchmark.LiteralSearchResult, error) {
		if question.NoMatch {
			return benchmark.LiteralSearchResult{}, nil
		}
		return benchmark.LiteralSearchResult{
			Candidates:        []graph.Node{{ID: question.AcceptableSeeds[0], Evidence: graph.FactEvidence{Span: graph.SourceSpan{Path: firstPath(question)}}}},
			Facts:             graph.Facts{Edges: []graph.Edge{{SourceID: "source", TargetID: "target", Relation: firstRelation(question)}}},
			TruncationReasons: []storage.TruncationReason{storage.TruncatedByDepthLimit},
		}, nil
	}
	now := steppedClock(time.Unix(0, 0), time.Millisecond)
	first, err := benchmark.RunLiteralSearchBaseline(context.Background(), questions, execute, now)
	if err != nil {
		t.Fatalf("run literal-search baseline: %v", err)
	}
	second, err := benchmark.RunLiteralSearchBaseline(context.Background(), questions, execute, steppedClock(time.Unix(0, 0), time.Millisecond))
	if err != nil {
		t.Fatalf("repeat literal-search baseline: %v", err)
	}

	if len(first.Results) != 30 || first.RecallAt10 != 1 || first.IntentAccuracy != 0 {
		t.Errorf("baseline summary = results:%d recall:%v intent:%v, want 30, 1, 0", len(first.Results), first.RecallAt10, first.IntentAccuracy)
	}
	if first.P50Latency != time.Millisecond || first.P95Latency != time.Millisecond {
		t.Errorf("baseline latency = p50:%s p95:%s, want 1ms", first.P50Latency, first.P95Latency)
	}
	if first.SeedDiversity <= 0 || first.TruncatedQuestions != 29 {
		t.Errorf("baseline diversity/truncation = %v/%d, want positive/29", first.SeedDiversity, first.TruncatedQuestions)
	}
	if first.OutputHash == "" || first.OutputHash != second.OutputHash {
		t.Errorf("baseline hashes = %q and %q, want equal nonempty hashes", first.OutputHash, second.OutputHash)
	}
	for index := range first.Results {
		if first.Results[index].OutputHash == "" || first.Results[index].OutputHash != second.Results[index].OutputHash {
			t.Errorf("result %d hashes = %q and %q, want equal nonempty hashes", index, first.Results[index].OutputHash, second.Results[index].OutputHash)
		}
	}
}

func TestLiteralQueryBaselinePinsCurrentSentenceAsTermBehavior(t *testing.T) {
	root := t.TempDir()
	if _, err := benchmark.GenerateCorpus(root, benchmark.CorpusSpec{SourceFiles: 3, FunctionsPerFile: 4}); err != nil {
		t.Fatalf("generate corpus: %v", err)
	}
	store, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "baseline.db"))
	if err != nil {
		t.Fatalf("open baseline database: %v", err)
	}
	defer store.Close()
	indexed, err := index.Index(context.Background(), store, index.Request{Root: root})
	if err != nil {
		t.Fatalf("index baseline corpus: %v", err)
	}

	execute := benchmark.NewLiteralQueryExecutor(store, store, indexed.Snapshot, 2, 100)
	first, err := benchmark.RunLiteralSearchBaseline(context.Background(), benchmark.ArchitectureQuestions(), execute, time.Now)
	if err != nil {
		t.Fatalf("run current literal baseline: %v", err)
	}
	second, err := benchmark.RunLiteralSearchBaseline(context.Background(), benchmark.ArchitectureQuestions(), execute, time.Now)
	if err != nil {
		t.Fatalf("repeat current literal baseline: %v", err)
	}

	const currentLiteralOutputHash = "sha256:f8b06c765eae589f119c72a6bcfe4ba253f1292c43562c46700424683ebc5463"
	if first.OutputHash != currentLiteralOutputHash || second.OutputHash != currentLiteralOutputHash {
		t.Errorf("literal baseline hashes = %q and %q, want pinned %q", first.OutputHash, second.OutputHash, currentLiteralOutputHash)
	}
	if first.IntentAccuracy != 0 {
		t.Errorf("literal baseline intent accuracy = %v, want 0 before question analysis", first.IntentAccuracy)
	}
}

func firstPath(question benchmark.ArchitectureQuestion) string {
	if len(question.AcceptablePaths) > 0 {
		return question.AcceptablePaths[0]
	}
	return "fixture.go"
}

func firstRelation(question benchmark.ArchitectureQuestion) graph.RelationKind {
	if len(question.RequiredRelations) > 0 {
		return question.RequiredRelations[0]
	}
	return "contains"
}

func steppedClock(start time.Time, step time.Duration) func() time.Time {
	current := start.Add(-step)
	return func() time.Time {
		current = current.Add(step)
		return current
	}
}
