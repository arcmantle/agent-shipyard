package extractor_test

import (
	"context"
	"errors"
	"testing"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
)

func TestNewContributionAcceptsValidatedDatabaseNeutralData(t *testing.T) {
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: []graph.NodeKind{"file"},
	})
	if err != nil {
		t.Fatalf("new vocabulary: %v", err)
	}

	evidence := graph.FactEvidence{
		Span: graph.SourceSpan{
			Path:        "src/main.ts",
			StartLine:   1,
			StartColumn: 1,
			EndLine:     1,
			EndColumn:   1,
		},
		FileHash:   "sha256:fixture",
		Extractor:  "typescript",
		Provenance: "static",
		Confidence: graph.ConfidenceExtracted,
	}
	input := extractor.ContributionInput{
		SourcePath: "src/main.ts",
		Metadata: extractor.Metadata{
			Name:       "typescript",
			Version:    "v0",
			Extensions: []string{".ts"},
		},
		Facts: graph.Facts{
			Nodes: []graph.Node{{ID: "file:main", Kind: "file", Evidence: evidence}},
		},
		UnresolvedReferences: []extractor.UnresolvedReference{{
			SourceID: "file:main",
			Target:   "./other",
			Kind:     extractor.ModuleReferenceImport,
			Bindings: []extractor.ModuleBinding{{ImportedName: "helper"}},
		}},
		ExportedSurfaces: []extractor.ExportedSurface{{
			NodeID: "file:main",
			Name:   "main",
		}},
		Dependencies: []extractor.Dependency{{
			SourcePath: "src/main.ts",
			TargetPath: "src/other.ts",
		}},
		Diagnostics: []extractor.Diagnostic{{
			Severity: extractor.DiagnosticWarning,
			Message:  "fixture diagnostic",
		}},
	}

	contribution, err := extractor.NewContribution(vocabulary, input)
	if err != nil {
		t.Fatalf("new contribution: %v", err)
	}

	input.Facts.Nodes[0].ID = "changed"
	input.Metadata.Extensions[0] = ".changed"
	input.UnresolvedReferences[0].Target = "changed"
	input.UnresolvedReferences[0].Bindings[0].ImportedName = "changed"
	input.ExportedSurfaces[0].Name = "changed"
	input.Dependencies[0].TargetPath = "changed"
	input.Diagnostics[0].Message = "changed"

	if got := contribution.Facts().Nodes[0].ID; got != "file:main" {
		t.Errorf("fact node ID = %q, want %q", got, "file:main")
	}
	if got := contribution.Metadata().Extensions[0]; got != ".ts" {
		t.Errorf("metadata extension = %q, want %q", got, ".ts")
	}
	if got := contribution.SourcePath(); got != "src/main.ts" {
		t.Errorf("contribution source path = %q, want %q", got, "src/main.ts")
	}
	if got := contribution.UnresolvedReferences()[0].Target; got != "./other" {
		t.Errorf("unresolved target = %q, want %q", got, "./other")
	}
	if got := contribution.UnresolvedReferences()[0].Bindings[0].ImportedName; got != "helper" {
		t.Errorf("module binding imported name = %q, want %q", got, "helper")
	}
	if got := contribution.ExportedSurfaces()[0].Name; got != "main" {
		t.Errorf("exported surface name = %q, want %q", got, "main")
	}
	if got := contribution.Dependencies()[0].TargetPath; got != "src/other.ts" {
		t.Errorf("dependency target = %q, want %q", got, "src/other.ts")
	}
	if got := contribution.Diagnostics()[0].Message; got != "fixture diagnostic" {
		t.Errorf("diagnostic message = %q, want %q", got, "fixture diagnostic")
	}
}

func TestNewContributionPreservesCatalogUnits(t *testing.T) {
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: []graph.NodeKind{"file"},
	})
	if err != nil {
		t.Fatalf("new vocabulary: %v", err)
	}

	input := extractor.ContributionInput{
		SourcePath: "src/main.go",
		Metadata:   extractor.Metadata{Name: "go", Version: "v0", Extensions: []string{".go"}},
		Facts: graph.Facts{Nodes: []graph.Node{{
			ID:   "function:validate",
			Kind: "file",
			Evidence: graph.FactEvidence{
				Span:       graph.SourceSpan{Path: "src/main.go", StartLine: 1, StartColumn: 1, EndLine: 1, EndColumn: 1},
				FileHash:   "sha256:fixture",
				Extractor:  "go",
				Provenance: "static",
				Confidence: graph.ConfidenceExtracted,
			},
		}}},
		CatalogUnits: []extractor.CatalogUnit{{
			NodeID:           "function:validate",
			Name:             "ValidateToken",
			Kind:             "go:function",
			Signature:        "func ValidateToken(token string) error",
			Comments:         []string{"ValidateToken checks a signed token."},
			IdentifierTokens: []string{"validate", "token"},
		}},
	}

	contribution, err := extractor.NewContribution(vocabulary, input)
	if err != nil {
		t.Fatalf("new contribution: %v", err)
	}
	input.CatalogUnits[0].Comments[0] = "changed"
	input.CatalogUnits[0].IdentifierTokens[0] = "changed"

	units := contribution.CatalogUnits()
	if len(units) != 1 {
		t.Fatalf("catalog unit count = %d, want 1", len(units))
	}
	if got := units[0]; got.NodeID != "function:validate" || got.Name != "ValidateToken" || got.Kind != "go:function" || got.Signature != "func ValidateToken(token string) error" || got.Comments[0] != "ValidateToken checks a signed token." || got.IdentifierTokens[0] != "validate" {
		t.Errorf("catalog unit = %+v, want original source data", got)
	}
}

func TestNewGraphUpdateGroupsImmutableContributions(t *testing.T) {
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{"file"}})
	if err != nil {
		t.Fatalf("new vocabulary: %v", err)
	}
	contribution, err := extractor.NewContribution(vocabulary, extractor.ContributionInput{
		SourcePath: "src/main.ts",
		Metadata:   extractor.Metadata{Name: "typescript", Version: "v0", Extensions: []string{".ts"}},
		Facts: graph.Facts{Nodes: []graph.Node{{
			ID:   "file:main",
			Kind: "file",
			Evidence: graph.FactEvidence{
				Span:       graph.SourceSpan{Path: "src/main.ts", StartLine: 1, StartColumn: 1, EndLine: 1, EndColumn: 1},
				FileHash:   "sha256:fixture",
				Extractor:  "typescript",
				Provenance: "static",
				Confidence: graph.ConfidenceExtracted,
			},
		}}},
	})
	if err != nil {
		t.Fatalf("new contribution: %v", err)
	}

	update, err := extractor.NewGraphUpdate([]extractor.Contribution{contribution})
	if err != nil {
		t.Fatalf("new graph update: %v", err)
	}

	contributions := update.Contributions()
	contributions[0] = extractor.Contribution{}
	if got := len(update.Contributions()); got != 1 {
		t.Errorf("contribution count = %d, want 1", got)
	}
}

func TestNewContributionRejectsMalformedData(t *testing.T) {
	vocabulary, err := graph.NewVocabulary(graph.VocabularyDefinition{NodeKinds: []graph.NodeKind{"file"}})
	if err != nil {
		t.Fatalf("new vocabulary: %v", err)
	}

	testCases := []struct {
		name   string
		mutate func(*extractor.ContributionInput)
	}{
		{
			name: "empty source path",
			mutate: func(input *extractor.ContributionInput) {
				input.SourcePath = ""
			},
		},
		{
			name: "invalid metadata",
			mutate: func(input *extractor.ContributionInput) {
				input.Metadata.Name = ""
			},
		},
		{
			name: "unregistered fact kind",
			mutate: func(input *extractor.ContributionInput) {
				input.Facts.Nodes[0].Kind = "unknown"
			},
		},
		{
			name: "incomplete catalog unit",
			mutate: func(input *extractor.ContributionInput) {
				input.CatalogUnits = []extractor.CatalogUnit{{
					NodeID: "file:main",
					Name:   "main",
					Kind:   "file",
				}}
			},
		},
		{
			name: "unresolved reference without local source",
			mutate: func(input *extractor.ContributionInput) {
				input.UnresolvedReferences = []extractor.UnresolvedReference{{SourceID: "missing", Target: "./other"}}
			},
		},
		{
			name: "exported surface without local node",
			mutate: func(input *extractor.ContributionInput) {
				input.ExportedSurfaces = []extractor.ExportedSurface{{NodeID: "missing", Name: "main"}}
			},
		},
		{
			name: "incomplete dependency",
			mutate: func(input *extractor.ContributionInput) {
				input.Dependencies = []extractor.Dependency{{SourcePath: "src/main.ts"}}
			},
		},
		{
			name: "unsupported diagnostic severity",
			mutate: func(input *extractor.ContributionInput) {
				input.Diagnostics = []extractor.Diagnostic{{Severity: "unknown", Message: "fixture diagnostic"}}
			},
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			input := validContributionInput()
			testCase.mutate(&input)
			if _, err := extractor.NewContribution(vocabulary, input); err == nil {
				t.Fatal("new contribution returned nil error")
			}
		})
	}
}

func TestNewGraphUpdateRejectsNoContributions(t *testing.T) {
	if _, err := extractor.NewGraphUpdate(nil); err == nil {
		t.Fatal("new graph update returned nil error")
	}
}

func TestResolverFileViewRequiresProjectRootAndCopiesFiles(t *testing.T) {
	if _, err := extractor.NewResolverFileView("", nil); err == nil {
		t.Fatal("new resolver file view returned nil error for an empty project root")
	}

	files := map[string][]byte{"tsconfig.json": []byte("original")}
	view, err := extractor.NewResolverFileView(".", files)
	if err != nil {
		t.Fatalf("new resolver file view: %v", err)
	}
	files["tsconfig.json"][0] = 'c'

	contents, found := view.File("tsconfig.json")
	if !found || string(contents) != "original" {
		t.Fatalf("view contents = %q, want %q", contents, "original")
	}
	contents[0] = 'c'

	contents, found = view.File("tsconfig.json")
	if !found || string(contents) != "original" {
		t.Errorf("view contents after caller mutation = %q, want %q", contents, "original")
	}
}

func TestPageResolverIndexCachesTargetAndReturnsDefensiveCopies(t *testing.T) {
	request := extractor.ResolverTargetRequest{ProjectID: "project:fixture", Language: "typescript", SourcePath: "src/helper.ts"}
	underlying := &resolverIndexStub{target: extractor.ResolverTarget{
		ProjectID:  "project:fixture",
		SourcePath: "src/helper.ts",
		Metadata:   extractor.Metadata{Name: "typescript", Extensions: []string{".ts"}},
		Nodes:      []graph.Node{{ID: "function:helper"}},
		UnresolvedReferences: []extractor.UnresolvedReference{{
			SourceID: "function:helper",
			Target:   "./support",
			Bindings: []extractor.ModuleBinding{{ImportedName: "support"}},
		}},
		SymbolReferences: []extractor.SymbolReference{{SourceID: "function:helper", Target: "support"}},
		ExportedSurfaces: []extractor.ExportedSurface{{NodeID: "function:helper", Name: "helper"}},
		Diagnostics:      []extractor.Diagnostic{{Severity: extractor.DiagnosticWarning, Message: "fixture"}},
	}, found: true}
	index := extractor.NewPageResolverIndex(underlying)

	target, found, err := index.ResolverTarget(context.Background(), request)
	if err != nil || !found {
		t.Fatalf("resolve target: found = %t, error = %v", found, err)
	}
	target.Metadata.Extensions[0] = ".changed"
	target.Nodes[0].ID = "changed"
	target.UnresolvedReferences[0].Target = "changed"
	target.UnresolvedReferences[0].Bindings[0].ImportedName = "changed"
	target.SymbolReferences[0].Target = "changed"
	target.ExportedSurfaces[0].Name = "changed"
	target.Diagnostics[0].Message = "changed"

	target, found, err = index.ResolverTarget(context.Background(), request)
	if err != nil || !found {
		t.Fatalf("resolve cached target: found = %t, error = %v", found, err)
	}
	if underlying.targetReads != 1 {
		t.Errorf("underlying target reads = %d, want 1", underlying.targetReads)
	}
	if target.Metadata.Extensions[0] != ".ts" || target.Nodes[0].ID != "function:helper" ||
		target.UnresolvedReferences[0].Target != "./support" || target.UnresolvedReferences[0].Bindings[0].ImportedName != "support" ||
		target.SymbolReferences[0].Target != "support" || target.ExportedSurfaces[0].Name != "helper" || target.Diagnostics[0].Message != "fixture" {
		t.Errorf("cached target was changed through a returned value: %+v", target)
	}
}

func TestPageResolverIndexCachesPackagePageAndReturnsDefensiveCopies(t *testing.T) {
	request := extractor.ResolverPackagePageRequest{
		ProjectID:   "project:fixture",
		Language:    "go",
		PackagePath: "internal/helper",
		Limit:       100,
	}
	underlying := &resolverIndexStub{packagePage: []extractor.ResolverTarget{{
		ProjectID:  "project:fixture",
		SourcePath: "internal/helper/helper.go",
		Nodes:      []graph.Node{{ID: "function:helper"}},
	}}}
	index := extractor.NewPageResolverIndex(underlying)

	page, err := index.ResolverPackagePage(context.Background(), request)
	if err != nil {
		t.Fatalf("resolve package page: %v", err)
	}
	page[0].SourcePath = "changed.go"
	page[0].Nodes[0].ID = "changed"
	page = append(page, extractor.ResolverTarget{SourcePath: "extra.go"})

	page, err = index.ResolverPackagePage(context.Background(), request)
	if err != nil {
		t.Fatalf("resolve cached package page: %v", err)
	}
	if underlying.packagePageReads != 1 {
		t.Errorf("underlying package page reads = %d, want 1", underlying.packagePageReads)
	}
	if len(page) != 1 || page[0].SourcePath != "internal/helper/helper.go" || page[0].Nodes[0].ID != "function:helper" {
		t.Errorf("cached package page was changed through a returned value: %+v", page)
	}
}

func TestPageResolverIndexCachesMissingAndFailedResults(t *testing.T) {
	targetRequest := extractor.ResolverTargetRequest{ProjectID: "project:fixture", Language: "typescript", SourcePath: "src/missing.ts"}
	missing := &resolverIndexStub{}
	index := extractor.NewPageResolverIndex(missing)
	for range 2 {
		if _, found, err := index.ResolverTarget(context.Background(), targetRequest); err != nil || found {
			t.Fatalf("resolve missing target: found = %t, error = %v", found, err)
		}
	}
	if missing.targetReads != 1 {
		t.Errorf("underlying missing target reads = %d, want 1", missing.targetReads)
	}
	for range 2 {
		page, err := index.ResolverPackagePage(context.Background(), extractor.ResolverPackagePageRequest{ProjectID: "project:fixture", Language: "go", PackagePath: "missing", Limit: 100})
		if err != nil || page != nil {
			t.Fatalf("resolve missing package page: page = %+v, error = %v; want nil page and nil error", page, err)
		}
	}
	if missing.packagePageReads != 1 {
		t.Errorf("underlying missing package page reads = %d, want 1", missing.packagePageReads)
	}

	targetError := errors.New("target read failed")
	packageError := errors.New("package read failed")
	failed := &resolverIndexStub{targetError: targetError, packagePageError: packageError}
	index = extractor.NewPageResolverIndex(failed)
	packageRequest := extractor.ResolverPackagePageRequest{ProjectID: "project:fixture", Language: "go", PackagePath: "missing", Limit: 100}
	for range 2 {
		if _, _, err := index.ResolverTarget(context.Background(), targetRequest); !errors.Is(err, targetError) {
			t.Fatalf("resolve failed target error = %v, want %v", err, targetError)
		}
		if _, err := index.ResolverPackagePage(context.Background(), packageRequest); !errors.Is(err, packageError) {
			t.Fatalf("resolve failed package page error = %v, want %v", err, packageError)
		}
	}
	if failed.targetReads != 1 || failed.packagePageReads != 1 {
		t.Errorf("underlying failed reads = target %d, package page %d; want 1 each", failed.targetReads, failed.packagePageReads)
	}
}

func TestPageResolverIndexUsesCompleteRequestsAndHasPageLifetime(t *testing.T) {
	underlying := &resolverIndexStub{}
	targetRequest := extractor.ResolverTargetRequest{ProjectID: "project:fixture", Language: "typescript", SourcePath: "src/helper.ts"}
	packageRequest := extractor.ResolverPackagePageRequest{ProjectID: "project:fixture", Language: "go", PackagePath: "internal/helper", Limit: 100}

	index := extractor.NewPageResolverIndex(underlying)
	_, _, _ = index.ResolverTarget(context.Background(), targetRequest)
	differentTargetRequest := targetRequest
	differentTargetRequest.Language = "javascript"
	_, _, _ = index.ResolverTarget(context.Background(), differentTargetRequest)
	_, _ = index.ResolverPackagePage(context.Background(), packageRequest)
	differentPackageRequest := packageRequest
	differentPackageRequest.AfterSourcePath = "internal/helper/first.go"
	_, _ = index.ResolverPackagePage(context.Background(), differentPackageRequest)

	newPageIndex := extractor.NewPageResolverIndex(underlying)
	_, _, _ = newPageIndex.ResolverTarget(context.Background(), targetRequest)
	_, _ = newPageIndex.ResolverPackagePage(context.Background(), packageRequest)

	if underlying.targetReads != 3 || underlying.packagePageReads != 3 {
		t.Errorf("underlying reads = target %d, package page %d; want 3 each", underlying.targetReads, underlying.packagePageReads)
	}
}

type resolverIndexStub struct {
	target           extractor.ResolverTarget
	found            bool
	targetError      error
	targetReads      int
	packagePage      []extractor.ResolverTarget
	packagePageError error
	packagePageReads int
}

func (index *resolverIndexStub) ResolverTarget(context.Context, extractor.ResolverTargetRequest) (extractor.ResolverTarget, bool, error) {
	index.targetReads++
	return index.target, index.found, index.targetError
}

func (index *resolverIndexStub) ResolverPackagePage(context.Context, extractor.ResolverPackagePageRequest) ([]extractor.ResolverTarget, error) {
	index.packagePageReads++
	return index.packagePage, index.packagePageError
}

func validContributionInput() extractor.ContributionInput {
	evidence := graph.FactEvidence{
		Span:       graph.SourceSpan{Path: "src/main.ts", StartLine: 1, StartColumn: 1, EndLine: 1, EndColumn: 1},
		FileHash:   "sha256:fixture",
		Extractor:  "typescript",
		Provenance: "static",
		Confidence: graph.ConfidenceExtracted,
	}
	return extractor.ContributionInput{
		SourcePath: "src/main.ts",
		Metadata:   extractor.Metadata{Name: "typescript", Version: "v0", Extensions: []string{".ts"}},
		Facts:      graph.Facts{Nodes: []graph.Node{{ID: "file:main", Kind: "file", Evidence: evidence}}},
	}
}
