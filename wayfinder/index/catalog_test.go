package index_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"agent-wayfinder/extractor"
	goextractor "agent-wayfinder/extractors/go"
	"agent-wayfinder/index"
	"agent-wayfinder/storage"
)

type catalogWriterStub struct {
	snapshot storage.Snapshot
	request  storage.CatalogWriteRequest
}

func (writer *catalogWriterStub) WriteCatalog(_ context.Context, snapshot storage.Snapshot, request storage.CatalogWriteRequest) error {
	writer.snapshot = snapshot
	writer.request = request
	return nil
}

type catalogEmbeddingWriterStub struct {
	catalogWriterStub
	request      storage.CatalogEmbeddingWriteRequest
	embeddingErr error
}

func (writer *catalogEmbeddingWriterStub) WriteCatalogEmbeddings(_ context.Context, snapshot storage.Snapshot, request storage.CatalogEmbeddingWriteRequest) error {
	writer.snapshot = snapshot
	writer.request = request
	return writer.embeddingErr
}

type catalogEmbeddingGeneratorStub struct {
	inputs []string
	err    error
}

func (generator *catalogEmbeddingGeneratorStub) GenerateCatalogEmbedding(_ context.Context, text string) ([]float32, error) {
	generator.inputs = append(generator.inputs, text)
	if generator.err != nil {
		return nil, generator.err
	}
	return []float32{float32(len(generator.inputs))}, nil
}

type catalogEmbeddingBatchGeneratorStub struct {
	mu       sync.Mutex
	batches  [][]string
	released bool
}

func (generator *catalogEmbeddingBatchGeneratorStub) GenerateCatalogEmbedding(_ context.Context, text string) ([]float32, error) {
	return []float32{float32(len(text))}, nil
}

func (generator *catalogEmbeddingBatchGeneratorStub) GenerateCatalogEmbeddings(_ context.Context, texts []string) ([][]float32, error) {
	generator.mu.Lock()
	defer generator.mu.Unlock()
	generator.batches = append(generator.batches, append([]string(nil), texts...))
	vectors := make([][]float32, len(texts))
	for index := range texts {
		vectors[index] = []float32{float32(index + 1)}
	}
	return vectors, nil
}

func (generator *catalogEmbeddingBatchGeneratorStub) ReleaseCatalogEmbeddingModel(context.Context) error {
	generator.mu.Lock()
	defer generator.mu.Unlock()
	generator.released = true
	return nil
}

type blockingCatalogEmbeddingBatchGenerator struct {
	started chan<- struct{}
	release <-chan struct{}
	mu      sync.Mutex
	active  int
	maximum int
}

func (generator *blockingCatalogEmbeddingBatchGenerator) GenerateCatalogEmbedding(_ context.Context, text string) ([]float32, error) {
	return []float32{float32(len(text))}, nil
}

func (generator *blockingCatalogEmbeddingBatchGenerator) GenerateCatalogEmbeddings(_ context.Context, texts []string) ([][]float32, error) {
	generator.mu.Lock()
	generator.active++
	generator.maximum = max(generator.maximum, generator.active)
	generator.mu.Unlock()
	generator.started <- struct{}{}
	<-generator.release
	generator.mu.Lock()
	generator.active--
	generator.mu.Unlock()
	vectors := make([][]float32, len(texts))
	for index := range texts {
		vectors[index] = []float32{float32(index + 1)}
	}
	return vectors, nil
}

func (generator *blockingCatalogEmbeddingBatchGenerator) ReleaseCatalogEmbeddingModel(context.Context) error {
	return nil
}

func TestWriteDeterministicCatalogWritesCatalogUnits(t *testing.T) {
	contribution, err := goextractor.Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/validator.go",
		Contents:   []byte("package fixture\n\n// ValidateToken checks a signed access token.\nfunc ValidateToken(token string) error { return nil }\nfunc local() { value := 1; _ = value }\n"),
	})
	if err != nil {
		t.Fatalf("extract Go source: %v", err)
	}
	writer := &catalogWriterStub{}
	snapshot := storage.Snapshot{Workspace: "fixture", Version: 1}

	if err := index.WriteDeterministicCatalog(context.Background(), writer, snapshot, []extractor.Contribution{contribution}); err != nil {
		t.Fatalf("write deterministic catalog: %v", err)
	}

	if writer.snapshot != snapshot {
		t.Errorf("catalog snapshot = %+v, want %+v", writer.snapshot, snapshot)
	}
	if len(writer.request.Entries) != 2 {
		t.Fatalf("catalog entry count = %d, want 2", len(writer.request.Entries))
	}
	entry := writer.request.Entries[0]
	if entry.Name != "ValidateToken" || entry.CopilotSynopsis != "" || entry.DeterministicSynopsis != "ValidateToken (go:function). ValidateToken checks a signed access token. Signature: func ValidateToken(token string) error. Identifiers: validate token" {
		t.Errorf("catalog entry = %+v, want deterministic ValidateToken entry", entry)
	}
}

type catalogSynopsisGeneratorStub struct {
	synopsis string
	err      error
}

func (generator catalogSynopsisGeneratorStub) GenerateCatalogSynopsis(_ context.Context, _ index.CatalogSynopsisInput) (string, error) {
	return generator.synopsis, generator.err
}

type catalogSynopsisCaptureStub struct {
	inputs   []index.CatalogSynopsisInput
	synopsis string
}

func (generator *catalogSynopsisCaptureStub) GenerateCatalogSynopsis(_ context.Context, input index.CatalogSynopsisInput) (string, error) {
	generator.inputs = append(generator.inputs, input)
	return generator.synopsis, nil
}

func TestWriteCatalogBoundsSourceForSelectedSynopsisProvider(t *testing.T) {
	contribution, err := goextractor.Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/validator.go",
		Contents:   []byte("package fixture\n\ntype Validator struct{}\n\n// ValidateToken checks a signed access token.\nfunc (Validator) ValidateToken(token string) error { return nil }\n"),
	})
	if err != nil {
		t.Fatalf("extract Go source: %v", err)
	}
	for _, testCase := range []struct {
		name     string
		provider index.CatalogSynopsisProvider
		stored   func(storage.CatalogEntry) string
	}{
		{name: "Copilot", provider: index.CatalogSynopsisProviderCopilot, stored: func(entry storage.CatalogEntry) string { return entry.CopilotSynopsis }},
		{name: "Ollama", provider: index.CatalogSynopsisProviderOllama, stored: func(entry storage.CatalogEntry) string { return entry.OllamaSynopsis }},
		{name: "Claude", provider: index.CatalogSynopsisProviderClaude, stored: func(entry storage.CatalogEntry) string { return entry.ClaudeSynopsis }},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			writer := &catalogWriterStub{}
			generator := &catalogSynopsisCaptureStub{synopsis: "Validates signed access tokens."}

			_, err = index.WriteCatalog(context.Background(), writer, storage.Snapshot{Workspace: "fixture", Version: 1}, []extractor.Contribution{contribution}, index.CatalogWriteOptions{
				SynopsisGenerator:    generator,
				SynopsisProvider:     testCase.provider,
				SynopsisSourceLimit:  5,
				SynopsisProcessLimit: 1,
			})
			if err != nil {
				t.Fatalf("write catalog: %v", err)
			}
			var got index.CatalogSynopsisInput
			for _, input := range generator.inputs {
				if input.Name == "ValidateToken" {
					got = input
					break
				}
			}
			want := index.CatalogSynopsisInput{Name: "ValidateToken", Kind: "go:method", Owner: "Validator", Signature: "func (Validator) ValidateToken(token string) error", DeclarationSource: "func ", Comments: []string{"ValidateToken checks a signed access token."}, IdentifierTokens: []string{"validate", "token"}}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("synopsis input = %+v, want %+v", got, want)
			}
			for _, entry := range writer.request.Entries {
				if entry.Name == "ValidateToken" && testCase.stored(entry) != "Validates signed access tokens." {
					t.Errorf("catalog entry = %+v, want stored %s synopsis", entry, testCase.provider)
				}
			}
		})
	}
}

func TestWriteCatalogKeepsDeterministicSynopsisWhenSelectedProviderIsUnavailable(t *testing.T) {
	contribution, err := goextractor.Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/validator.go",
		Contents:   []byte("package fixture\n\n// ValidateToken checks a signed access token.\nfunc ValidateToken(token string) error { return nil }\n"),
	})
	if err != nil {
		t.Fatalf("extract Go source: %v", err)
	}
	for _, testCase := range []struct {
		name        string
		options     index.CatalogWriteOptions
		unavailable func(index.CatalogWriteResult) string
	}{
		{
			name: "Copilot",
			options: index.CatalogWriteOptions{
				SynopsisGenerator:    catalogSynopsisGeneratorStub{err: errors.New("Copilot unavailable")},
				SynopsisProvider:     index.CatalogSynopsisProviderCopilot,
				SynopsisSourceLimit:  512,
				SynopsisProcessLimit: 1,
			},
			unavailable: func(result index.CatalogWriteResult) string { return result.CopilotUnavailableReason },
		},
		{
			name: "Ollama",
			options: index.CatalogWriteOptions{
				SynopsisGenerator:    catalogSynopsisGeneratorStub{err: errors.New("Ollama unavailable")},
				SynopsisProvider:     index.CatalogSynopsisProviderOllama,
				SynopsisSourceLimit:  512,
				SynopsisProcessLimit: 1,
			},
			unavailable: func(result index.CatalogWriteResult) string { return result.OllamaUnavailableReason },
		},
		{
			name: "Claude",
			options: index.CatalogWriteOptions{
				SynopsisGenerator:    catalogSynopsisGeneratorStub{err: errors.New("Claude unavailable")},
				SynopsisProvider:     index.CatalogSynopsisProviderClaude,
				SynopsisSourceLimit:  512,
				SynopsisProcessLimit: 1,
			},
			unavailable: func(result index.CatalogWriteResult) string { return result.ClaudeUnavailableReason },
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			writer := &catalogWriterStub{}
			result, err := index.WriteCatalog(context.Background(), writer, storage.Snapshot{Workspace: "fixture", Version: 1}, []extractor.Contribution{contribution}, testCase.options)
			if err != nil {
				t.Fatalf("write catalog: %v", err)
			}
			entry := writer.request.Entries[0]
			if entry.DeterministicSynopsis == "" || entry.CopilotSynopsis != "" || entry.OllamaSynopsis != "" || entry.ClaudeSynopsis != "" {
				t.Errorf("catalog entry = %+v, want only deterministic synopsis", entry)
			}
			if testCase.unavailable(result) == "" {
				t.Errorf("catalog result = %+v, want %s unavailable reason", result, testCase.name)
			}
		})
	}
}

func TestWriteCatalogStoresEmbeddingsForSelectedSynopsis(t *testing.T) {
	contribution, err := goextractor.Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/validator.go",
		Contents:   []byte("package fixture\nfunc ValidateToken(token string) error { return nil }\n"),
	})
	if err != nil {
		t.Fatalf("extract Go source: %v", err)
	}
	for _, testCase := range []struct {
		name           string
		provider       index.CatalogSynopsisProvider
		optionalSource storage.CatalogEmbeddingSource
	}{
		{name: "Copilot", provider: index.CatalogSynopsisProviderCopilot, optionalSource: storage.CatalogEmbeddingCopilot},
		{name: "Ollama", provider: index.CatalogSynopsisProviderOllama, optionalSource: storage.CatalogEmbeddingOllama},
		{name: "Claude", provider: index.CatalogSynopsisProviderClaude, optionalSource: storage.CatalogEmbeddingClaude},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			writer := &catalogEmbeddingWriterStub{}
			generator := &catalogEmbeddingGeneratorStub{}
			_, err := index.WriteCatalog(context.Background(), writer, storage.Snapshot{Workspace: "fixture", Version: 1}, []extractor.Contribution{contribution}, index.CatalogWriteOptions{
				SynopsisGenerator:    catalogSynopsisGeneratorStub{synopsis: "Validates signed access tokens."},
				SynopsisProvider:     testCase.provider,
				SynopsisSourceLimit:  512,
				SynopsisProcessLimit: 1,
				EmbeddingGenerator:   generator,
			})
			if err != nil {
				t.Fatalf("write catalog: %v", err)
			}
			if len(writer.request.Embeddings) != 2 {
				t.Fatalf("catalog embedding count = %d, want 2", len(writer.request.Embeddings))
			}
			if writer.request.Embeddings[0].Text != writer.catalogWriterStub.request.Entries[0].DeterministicSynopsis || writer.request.Embeddings[1].Text != "Validates signed access tokens." {
				t.Errorf("catalog embedding texts = %+v, want deterministic and stored optional synopsis", writer.request.Embeddings)
			}
			wantSources := []storage.CatalogEmbeddingSource{storage.CatalogEmbeddingDeterministic, testCase.optionalSource}
			for embeddingIndex, wantSource := range wantSources {
				if writer.request.Embeddings[embeddingIndex].Source != wantSource {
					t.Errorf("catalog embedding %d source = %q, want %q", embeddingIndex, writer.request.Embeddings[embeddingIndex].Source, wantSource)
				}
			}
			if len(generator.inputs) != 2 {
				t.Errorf("catalog embedding inputs = %q, want deterministic and stored optional synopsis", generator.inputs)
			}
		})
	}
}

func TestWriteCatalogBatchesEmbeddingsAndReleasesModel(t *testing.T) {
	contribution, err := goextractor.Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/validator.go",
		Contents:   []byte("package fixture\nfunc ValidateToken(token string) error { return nil }\n"),
	})
	if err != nil {
		t.Fatalf("extract Go source: %v", err)
	}
	writer := &catalogEmbeddingWriterStub{}
	generator := &catalogEmbeddingBatchGeneratorStub{}
	_, err = index.WriteCatalog(context.Background(), writer, storage.Snapshot{Workspace: "fixture", Version: 1}, []extractor.Contribution{contribution}, index.CatalogWriteOptions{
		SynopsisGenerator:    catalogSynopsisGeneratorStub{synopsis: "Validates signed access tokens."},
		SynopsisProvider:     index.CatalogSynopsisProviderCopilot,
		SynopsisSourceLimit:  512,
		SynopsisProcessLimit: 1,
		EmbeddingGenerator:   generator,
	})
	if err != nil {
		t.Fatalf("write catalog: %v", err)
	}
	if len(generator.batches) != 1 || len(generator.batches[0]) != 2 || !generator.released {
		t.Errorf("catalog embedding batches = %+v, released = %t; want one two-item batch and model release", generator.batches, generator.released)
	}
	if len(writer.request.Embeddings) != 2 {
		t.Errorf("catalog embedding count = %d, want 2", len(writer.request.Embeddings))
	}
}

func TestWriteCatalogRunsConfiguredEmbeddingBatchesInParallel(t *testing.T) {
	var source strings.Builder
	source.WriteString("package fixture\n")
	for functionIndex := range 33 {
		_, _ = fmt.Fprintf(&source, "func Function%d() {}\n", functionIndex)
	}
	contribution, err := goextractor.Extract(extractor.Source{ProjectID: "project:fixture", SourcePath: "src/fixture.go", Contents: []byte(source.String())})
	if err != nil {
		t.Fatalf("extract Go source: %v", err)
	}
	started := make(chan struct{}, index.MaximumEmbeddingProcessLimit)
	release := make(chan struct{})
	generator := &blockingCatalogEmbeddingBatchGenerator{started: started, release: release}
	done := make(chan error, 1)
	go func() {
		_, err := index.WriteCatalog(context.Background(), &catalogEmbeddingWriterStub{}, storage.Snapshot{Workspace: "fixture", Version: 1}, []extractor.Contribution{contribution}, index.CatalogWriteOptions{EmbeddingGenerator: generator, EmbeddingProcessLimit: index.MaximumEmbeddingProcessLimit})
		done <- err
	}()
	for range index.MaximumEmbeddingProcessLimit {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("catalog did not start the configured embedding workers")
		}
	}
	generator.mu.Lock()
	maximum := generator.maximum
	generator.mu.Unlock()
	if maximum != index.MaximumEmbeddingProcessLimit {
		t.Errorf("concurrent embedding batches = %d, want %d", maximum, index.MaximumEmbeddingProcessLimit)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("write catalog: %v", err)
	}
}

func TestOllamaCatalogEmbeddingGeneratorUsesConfiguredLocalModel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/embed" {
			t.Errorf("Ollama request path = %q, want /api/embed", request.URL.Path)
		}
		contents, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read Ollama request: %v", err)
		}
		if string(contents) != `{"model":"qwen3-embedding:4b","input":["checks a signed token"],"options":{"num_thread":1},"keep_alive":"0"}` {
			t.Errorf("Ollama request = %s, want configured model and synopsis", contents)
		}
		_, _ = response.Write([]byte(`{"embeddings":[[0.1,0.2]]}`))
	}))
	t.Cleanup(server.Close)

	generator, err := index.NewOllamaCatalogEmbeddingGenerator("qwen3-embedding:4b", server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("create Ollama embedding generator: %v", err)
	}
	vector, err := generator.GenerateCatalogEmbedding(context.Background(), "checks a signed token")
	if err != nil {
		t.Fatalf("generate local Ollama embedding: %v", err)
	}
	if len(vector) != 2 || vector[0] != 0.1 || vector[1] != 0.2 {
		t.Errorf("Ollama embedding = %v, want [0.1 0.2]", vector)
	}
}

func TestOllamaCatalogEmbeddingGeneratorBatchesInputsAndReleasesModel(t *testing.T) {
	var requests []struct {
		Path      string
		Input     []string `json:"input"`
		KeepAlive string   `json:"keep_alive"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var payload struct {
			Input     []string `json:"input"`
			KeepAlive string   `json:"keep_alive"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatalf("decode Ollama request: %v", err)
		}
		requests = append(requests, struct {
			Path      string
			Input     []string `json:"input"`
			KeepAlive string   `json:"keep_alive"`
		}{Path: request.URL.Path, Input: payload.Input, KeepAlive: payload.KeepAlive})
		if request.URL.Path == "/api/embed" {
			_, _ = response.Write([]byte(`{"embeddings":[[0.1],[0.2]]}`))
		}
	}))
	t.Cleanup(server.Close)

	generator, err := index.NewOllamaCatalogEmbeddingGenerator("qwen3-embedding:4b", server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("create Ollama embedding generator: %v", err)
	}
	vectors, err := generator.GenerateCatalogEmbeddings(context.Background(), []string{"first", "second"})
	if err != nil {
		t.Fatalf("generate batch embeddings: %v", err)
	}
	if !reflect.DeepEqual(vectors, [][]float32{{0.1}, {0.2}}) {
		t.Errorf("batch embeddings = %v, want two vectors", vectors)
	}
	if err := generator.ReleaseCatalogEmbeddingModel(context.Background()); err != nil {
		t.Fatalf("release embedding model: %v", err)
	}
	if len(requests) != 2 || requests[0].Path != "/api/embed" || !reflect.DeepEqual(requests[0].Input, []string{"first", "second"}) || requests[0].KeepAlive != "5m" || requests[1].Path != "/api/generate" || requests[1].KeepAlive != "0" {
		t.Errorf("Ollama requests = %+v, want one retained batch request and one release request", requests)
	}
}

func TestOllamaCatalogEmbeddingGeneratorRejectsOversizedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(response, strings.Repeat("x", 4*1024*1024+1))
	}))
	t.Cleanup(server.Close)

	generator, err := index.NewOllamaCatalogEmbeddingGenerator("qwen3-embedding:4b", server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("create Ollama embedding generator: %v", err)
	}
	_, err = generator.GenerateCatalogEmbedding(context.Background(), "checks a signed token")
	if err == nil || !strings.Contains(err.Error(), "exceeds 4194304 bytes") {
		t.Errorf("oversized Ollama embedding error = %v, want response size error", err)
	}
}

func TestWriteCatalogKeepsLexicalEntriesWhenEmbeddingsAreUnavailable(t *testing.T) {
	contribution, err := goextractor.Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/validator.go",
		Contents:   []byte("package fixture\nfunc ValidateToken(token string) error { return nil }\n"),
	})
	if err != nil {
		t.Fatalf("extract Go source: %v", err)
	}
	for _, testCase := range []struct {
		name         string
		generatorErr error
		storageErr   error
	}{
		{name: "model unavailable", generatorErr: errors.New("Ollama model not found")},
		{name: "embedding storage unavailable", storageErr: errors.New("catalog embedding storage failed")},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			writer := &catalogEmbeddingWriterStub{embeddingErr: testCase.storageErr}
			result, err := index.WriteCatalog(context.Background(), writer, storage.Snapshot{Workspace: "fixture", Version: 1}, []extractor.Contribution{contribution}, index.CatalogWriteOptions{
				EmbeddingGenerator: &catalogEmbeddingGeneratorStub{err: testCase.generatorErr},
			})
			if err != nil {
				t.Fatalf("write catalog: %v", err)
			}
			if len(writer.catalogWriterStub.request.Entries) != 1 || writer.catalogWriterStub.request.Entries[0].DeterministicSynopsis == "" {
				t.Errorf("lexical catalog entries = %+v, want deterministic entry", writer.catalogWriterStub.request.Entries)
			}
			if result.EmbeddingUnavailableReason == "" {
				t.Errorf("catalog result = %+v, want embedding unavailable reason", result)
			}
		})
	}
}

type blockingCatalogSynopsisGenerator struct {
	started chan struct{}
	release <-chan struct{}
	mu      sync.Mutex
	active  int
	maximum int
	calls   int
}

func (generator *blockingCatalogSynopsisGenerator) GenerateCatalogSynopsis(_ context.Context, _ index.CatalogSynopsisInput) (string, error) {
	generator.mu.Lock()
	generator.calls++
	generator.active++
	if generator.active > generator.maximum {
		generator.maximum = generator.active
	}
	generator.mu.Unlock()
	generator.started <- struct{}{}
	<-generator.release
	generator.mu.Lock()
	generator.active--
	generator.mu.Unlock()
	return "synopsis", nil
}

func TestWriteCatalogLimitsConcurrentSelectedSynopses(t *testing.T) {
	contribution, err := goextractor.Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/validator.go",
		Contents:   []byte("package fixture\nfunc First() {}\nfunc Second() {}\nfunc Third() {}\n"),
	})
	if err != nil {
		t.Fatalf("extract Go source: %v", err)
	}
	release := make(chan struct{})
	generator := &blockingCatalogSynopsisGenerator{started: make(chan struct{}, 3), release: release}
	done := make(chan error, 1)
	go func() {
		_, err := index.WriteCatalog(context.Background(), &catalogWriterStub{}, storage.Snapshot{Workspace: "fixture", Version: 1}, []extractor.Contribution{contribution}, index.CatalogWriteOptions{
			SynopsisGenerator:    generator,
			SynopsisProvider:     index.CatalogSynopsisProviderCopilot,
			SynopsisSourceLimit:  512,
			SynopsisProcessLimit: 2,
		})
		done <- err
	}()
	<-generator.started
	<-generator.started
	if count := len(generator.started); count != 0 {
		t.Errorf("started synopsis processes = %d after limit reached, want 0", count)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("write catalog: %v", err)
	}
	generator.mu.Lock()
	maximum := generator.maximum
	calls := generator.calls
	generator.mu.Unlock()
	if maximum != 2 {
		t.Errorf("maximum concurrent synopsis processes = %d, want 2", maximum)
	}
	if calls != 3 {
		t.Errorf("synopsis calls = %d, want 3 for three catalog units", calls)
	}
}
