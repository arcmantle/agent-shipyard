package goextractor

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"

	sitter "github.com/tree-sitter/go-tree-sitter"
)

func TestLanguageParsesGo(t *testing.T) {
	parser := sitter.NewParser()
	defer parser.Close()
	if err := parser.SetLanguage(Language()); err != nil {
		t.Fatalf("set Go language: %v", err)
	}

	tree := parser.Parse([]byte("package fixture\n\nfunc main() {}\n"), nil)
	defer tree.Close()
	if tree.RootNode().HasError() {
		t.Fatal("Go language did not parse valid source")
	}
}

func TestExtractReportsPositionedParseError(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		contents string
		want     string
	}{
		{
			name:     "error node",
			contents: "package fixture\n\nfunc broken( {\n",
			want:     `parse Go source "src/broken.go" at 3:1-3:15: ERROR`,
		},
		{
			name:     "missing node",
			contents: "package fixture\n\nfunc broken(\n",
			want:     `parse Go source "src/broken.go" at 3:13-3:13: missing )`,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := Extract(extractor.Source{
				ProjectID:  "project:fixture",
				SourcePath: "src/broken.go",
				Contents:   []byte(testCase.contents),
			})
			if err == nil {
				t.Fatal("extract malformed Go source: want error")
			}
			if !strings.Contains(err.Error(), testCase.want) {
				t.Errorf("parse error = %q, want %q", err, testCase.want)
			}
		})
	}
}

func TestWorkerExtractsSequentialSourcesWithoutChangingContribution(t *testing.T) {
	worker, err := NewWorker()
	if err != nil {
		t.Fatalf("create Go worker: %v", err)
	}
	t.Cleanup(func() {
		if err := worker.Close(); err != nil {
			t.Errorf("close Go worker: %v", err)
		}
	})

	for _, source := range []extractor.Source{
		{ProjectID: "project:fixture", SourcePath: "src/first.go", Contents: []byte("package fixture\n\nfunc First() {}\n")},
		{ProjectID: "project:fixture", SourcePath: "src/second.go", Contents: []byte("package fixture\n\nfunc Second() {}\n")},
	} {
		expected, err := Extract(source)
		if err != nil {
			t.Fatalf("extract baseline source %q: %v", source.SourcePath, err)
		}
		actual, err := worker.Extract(source)
		if err != nil {
			t.Fatalf("extract worker source %q: %v", source.SourcePath, err)
		}
		if !reflect.DeepEqual(actual, expected) {
			t.Errorf("worker contribution for %q differs from Extract", source.SourcePath)
		}
	}
}

func TestWorkersExtractConcurrentlyWithoutSharingParsers(t *testing.T) {
	const workerCount = 4
	var workers sync.WaitGroup
	errors := make(chan error, workerCount)
	workers.Add(workerCount)
	for workerIndex := 0; workerIndex < workerCount; workerIndex++ {
		go func(index int) {
			defer workers.Done()
			worker, err := NewWorker()
			if err != nil {
				errors <- err
				return
			}
			defer worker.Close()
			_, err = worker.Extract(extractor.Source{
				ProjectID:  "project:fixture",
				SourcePath: fmt.Sprintf("src/worker-%d.go", index),
				Contents:   []byte("package fixture\n\nfunc Worker() {}\n"),
			})
			if err != nil {
				errors <- err
			}
		}(workerIndex)
	}
	workers.Wait()
	close(errors)
	for err := range errors {
		t.Errorf("concurrent worker extraction: %v", err)
	}
}

func TestClosedWorkerReturnsActionableError(t *testing.T) {
	worker, err := NewWorker()
	if err != nil {
		t.Fatalf("create Go worker: %v", err)
	}
	if err := worker.Close(); err != nil {
		t.Fatalf("close Go worker: %v", err)
	}

	_, err = worker.Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/closed.go",
		Contents:   []byte("package fixture\n"),
	})
	if err == nil {
		t.Fatal("extract with closed Go worker succeeded")
	}
	if !strings.Contains(err.Error(), "worker is closed") {
		t.Errorf("closed worker error = %q, want actionable closed-worker error", err)
	}
}

func TestExtractProducesPackageAndFunctionFacts(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/greet.go",
		Contents:   []byte("package fixture\n\nfunc Greet() {}\n"),
	})
	if err != nil {
		t.Fatalf("extract Go facts: %v", err)
	}

	facts := contribution.Facts()
	if len(facts.Nodes) != 4 {
		t.Fatalf("node count = %d, want 4", len(facts.Nodes))
	}
	if len(facts.Edges) != 3 {
		t.Fatalf("edge count = %d, want 3", len(facts.Edges))
	}

	fileSpan := graph.SourceSpan{Path: "src/greet.go", StartLine: 1, StartColumn: 1, EndLine: 4, EndColumn: 1}
	packageSpan := graph.SourceSpan{Path: "src/greet.go", StartLine: 1, StartColumn: 1, EndLine: 1, EndColumn: 16}
	functionSpan := graph.SourceSpan{Path: "src/greet.go", StartLine: 3, StartColumn: 1, EndLine: 3, EndColumn: 16}
	wantFileID := graph.NewNodeID("file", fileSpan)
	wantPackageID := graph.NewNodeID(PackageNodeKind, packageSpan)
	wantFunctionID := graph.NewNodeID(FunctionNodeKind, functionSpan)

	if got := facts.Nodes[0]; got.ID != "project:fixture" || got.Kind != "project" || got.Label != "project:fixture" || got.QualifiedName != "project:fixture" {
		t.Errorf("project node = %+v, want project query names", got)
	}
	if got := facts.Nodes[1]; got.ID != wantFileID || got.Kind != "file" || got.Label != "src/greet.go" || got.QualifiedName != "src/greet.go" {
		t.Errorf("file node = %+v, want file node %q", got, wantFileID)
	}
	if got := facts.Nodes[2]; got.ID != wantPackageID || got.Kind != PackageNodeKind || got.Label != "fixture" || got.QualifiedName != "src/greet.go::fixture" {
		t.Errorf("package node = %+v, want package node %q", got, wantPackageID)
	}
	if got := facts.Nodes[3]; got.ID != wantFunctionID || got.Kind != FunctionNodeKind || got.Label != "Greet" || got.QualifiedName != "src/greet.go::fixture.Greet" {
		t.Errorf("function node = %+v, want function node %q", got, wantFunctionID)
	}
	if got := facts.Edges[0]; got.SourceID != "project:fixture" || got.TargetID != wantFileID || got.Relation != "contains" {
		t.Errorf("containment edge = %+v", got)
	}
	if got := facts.Edges[1]; got.SourceID != wantFileID || got.TargetID != wantPackageID || got.Relation != "defines" {
		t.Errorf("package definition edge = %+v", got)
	}
	if got := facts.Edges[2]; got.SourceID != wantPackageID || got.TargetID != wantFunctionID || got.Relation != "defines" {
		t.Errorf("function definition edge = %+v", got)
	}
}

func TestExtractProducesTypeAndMethodFacts(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/service.go",
		Contents:   []byte("package fixture\n\ntype Service struct{}\n\nfunc (Service) Run() {}\n"),
	})
	if err != nil {
		t.Fatalf("extract Go facts: %v", err)
	}

	packageID := findNodeID(t, contribution.Facts(), PackageNodeKind, "fixture")
	typeID := findNodeID(t, contribution.Facts(), StructNodeKind, "Service")
	methodID := findNodeID(t, contribution.Facts(), MethodNodeKind, "Run")
	if !hasFactEdge(contribution.Facts(), packageID, typeID, "defines") {
		t.Errorf("facts = %+v, want package definition for Service", contribution.Facts())
	}
	if !hasFactEdge(contribution.Facts(), packageID, methodID, "defines") {
		t.Errorf("facts = %+v, want package definition for Run", contribution.Facts())
	}

	for _, node := range contribution.Facts().Nodes {
		switch node.ID {
		case typeID:
			if node.QualifiedName != "src/service.go::fixture.Service" {
				t.Errorf("type qualified name = %q, want src/service.go::fixture.Service", node.QualifiedName)
			}
		case methodID:
			if node.QualifiedName != "src/service.go::fixture.Service.Run" {
				t.Errorf("method qualified name = %q, want src/service.go::fixture.Service.Run", node.QualifiedName)
			}
		}
	}
}

func TestExtractDifferentiatesGoDeclarationKinds(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/declarations.go",
		Contents:   []byte("package fixture\n\ntype Record struct{}\n\ntype Runner interface {\n\tRun()\n}\n\ntype Label = string\n\ntype Identifier string\n\nconst DefaultLabel Label = \"default\"\n\nconst First, Second = 1, 2\n\nvar Global Label\n"),
	})
	if err != nil {
		t.Fatalf("extract Go facts: %v", err)
	}

	facts := contribution.Facts()
	for name, kind := range map[string]graph.NodeKind{
		"Record":       "go:struct",
		"Runner":       "go:interface",
		"Label":        "go:type_alias",
		"Identifier":   TypeNodeKind,
		"DefaultLabel": "go:constant",
		"First":        "go:constant",
		"Second":       "go:constant",
		"Global":       VariableNodeKind,
	} {
		findNodeID(t, facts, kind, name)
	}

	catalogNames := make(map[string]bool)
	for _, unit := range contribution.CatalogUnits() {
		catalogNames[unit.Name] = true
	}
	for _, name := range []string{"Record", "Runner"} {
		if !catalogNames[name] {
			t.Errorf("catalog units = %+v, want %q", contribution.CatalogUnits(), name)
		}
	}
}

func TestExtractProvidesCatalogUnitSourceData(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/validator.go",
		Contents:   []byte("package fixture\n\n// ValidateToken checks a signed access token.\nfunc ValidateToken(token string) error { return nil }\n"),
	})
	if err != nil {
		t.Fatalf("extract Go facts: %v", err)
	}

	units := contribution.CatalogUnits()
	if len(units) != 1 {
		t.Fatalf("catalog unit count = %d, want 1", len(units))
	}
	unit := units[0]
	if unit.Name != "ValidateToken" || unit.Kind != FunctionNodeKind || unit.Signature != "func ValidateToken(token string) error" {
		t.Errorf("catalog unit = %+v, want function source data", unit)
	}
	if len(unit.Comments) != 1 || unit.Comments[0] != "ValidateToken checks a signed access token." {
		t.Errorf("catalog comments = %#v, want one declaration comment", unit.Comments)
	}
	if len(unit.IdentifierTokens) != 2 || unit.IdentifierTokens[0] != "validate" || unit.IdentifierTokens[1] != "token" {
		t.Errorf("catalog identifier tokens = %#v, want validate and token", unit.IdentifierTokens)
	}
}

func TestExtractProducesVariableAndLocalReferenceFacts(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.go",
		Contents:   []byte("package fixture\n\nfunc helper() int { return 1 }\n\nfunc main() int {\n\tvalue := helper()\n\treturn value\n}\n"),
	})
	if err != nil {
		t.Fatalf("extract Go facts: %v", err)
	}

	helperID := findNodeID(t, contribution.Facts(), FunctionNodeKind, "helper")
	mainID := findNodeID(t, contribution.Facts(), FunctionNodeKind, "main")
	variableID := findNodeID(t, contribution.Facts(), VariableNodeKind, "value")
	if !hasFactEdge(contribution.Facts(), mainID, variableID, "defines") {
		t.Errorf("facts = %+v, want main definition for value", contribution.Facts())
	}
	if !hasFactEdge(contribution.Facts(), mainID, helperID, "references") {
		t.Errorf("facts = %+v, want main reference to helper", contribution.Facts())
	}
	if !hasFactEdge(contribution.Facts(), mainID, helperID, CallsRelation) {
		t.Errorf("facts = %+v, want main call to helper", contribution.Facts())
	}
	if !hasReferenceEvidence(contribution.Facts(), mainID, helperID, graph.SourceSpan{Path: "src/main.go", StartLine: 6, StartColumn: 11, EndLine: 6, EndColumn: 17}) {
		t.Errorf("facts = %+v, want helper reference evidence at the call site", contribution.Facts())
	}
}

func TestExtractAddsCallFactForPackageFunctionValue(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.go",
		Contents:   []byte("package fixture\n\nvar callback = func() {}\n\nfunc main() { callback() }\n"),
	})
	if err != nil {
		t.Fatalf("extract Go facts: %v", err)
	}

	mainID := findNodeID(t, contribution.Facts(), FunctionNodeKind, "main")
	callbackID := findNodeID(t, contribution.Facts(), VariableNodeKind, "callback")
	if !hasFactEdge(contribution.Facts(), mainID, callbackID, CallsRelation) {
		t.Errorf("facts = %+v, want main call to function-valued callback", contribution.Facts())
	}
}

func TestResolveWithFileViewAddsCallFactForLocalFunctionValue(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.go",
		Contents:   []byte("package fixture\n\nfunc main() {\n\tcallback := func() {}\n\tcallback()\n}\n"),
	})
	if err != nil {
		t.Fatalf("extract Go facts: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{contribution}, extractor.ResolverFileView{})
	if err != nil {
		t.Fatalf("resolve Go facts: %v", err)
	}

	mainID := findNodeID(t, contribution.Facts(), FunctionNodeKind, "main")
	callbackID := findNodeID(t, contribution.Facts(), VariableNodeKind, "callback")
	if !hasFactEdge(resolution.Facts(), mainID, callbackID, CallsRelation) {
		t.Errorf("facts = %+v, want main call to local function-valued callback", resolution.Facts())
	}
}

func TestResolveWithFileViewDoesNotAddCallFactForNonFunctionValue(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.go",
		Contents:   []byte("package fixture\n\nfunc main() {\n\tvalue := 1\n\tvalue()\n}\n"),
	})
	if err != nil {
		t.Fatalf("extract Go facts: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{contribution}, extractor.ResolverFileView{})
	if err != nil {
		t.Fatalf("resolve Go facts: %v", err)
	}

	mainID := findNodeID(t, contribution.Facts(), FunctionNodeKind, "main")
	valueID := findNodeID(t, contribution.Facts(), VariableNodeKind, "value")
	if hasFactEdge(resolution.Facts(), mainID, valueID, CallsRelation) {
		t.Errorf("facts = %+v, must not add a call to non-function value", resolution.Facts())
	}
}

func TestExtractProvidesAliasImportBindingForResolution(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "cmd/main.go",
		Contents:   []byte("package main\n\nimport helper \"example.com/fixture/internal/support\"\n\nfunc Main() { helper.Run() }\n"),
	})
	if err != nil {
		t.Fatalf("extract Go facts: %v", err)
	}

	references := contribution.UnresolvedReferences()
	if len(references) != 1 {
		t.Fatalf("unresolved reference count = %d, want 1", len(references))
	}
	if got := references[0].Target; got != "example.com/fixture/internal/support" {
		t.Errorf("import target = %q, want example.com/fixture/internal/support", got)
	}
	if got := references[0].Bindings; !reflect.DeepEqual(got, []extractor.ModuleBinding{{ImportedName: "*", LocalName: "helper"}}) {
		t.Errorf("import bindings = %+v, want helper", got)
	}
}

func TestExtractExcludesNonCallableImportBindings(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		contents string
		target   string
	}{
		{
			name:     "unaliased import",
			contents: "package main\n\nimport \"example.com/fixture/internal/package_name_differs\"\n",
			target:   "example.com/fixture/internal/package_name_differs",
		},
		{
			name:     "dot import",
			contents: "package main\n\nimport . \"example.com/fixture/internal/support\"\n",
			target:   "example.com/fixture/internal/support",
		},
		{
			name:     "blank import",
			contents: "package main\n\nimport _ \"example.com/fixture/internal/register\"\n",
			target:   "example.com/fixture/internal/register",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			contribution, err := Extract(extractor.Source{
				ProjectID:  "project:fixture",
				SourcePath: "cmd/main.go",
				Contents:   []byte(testCase.contents),
			})
			if err != nil {
				t.Fatalf("extract Go facts: %v", err)
			}

			references := contribution.UnresolvedReferences()
			if len(references) != 1 {
				t.Fatalf("unresolved reference count = %d, want 1", len(references))
			}
			if got := references[0].Target; got != testCase.target {
				t.Errorf("import target = %q, want %q", got, testCase.target)
			}
			if len(references[0].Bindings) != 0 {
				t.Errorf("import bindings = %+v, want no callable binding", references[0].Bindings)
			}
		})
	}
}

func TestResolvePagePreservesLocalCallFacts(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.go",
		Contents:   []byte("package fixture\n\nfunc helper() int { return 1 }\n\nfunc main() int {\n\treturn helper()\n}\n"),
	})
	if err != nil {
		t.Fatalf("extract Go facts: %v", err)
	}

	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{contribution}, "project:fixture", pageResolverIndex{}, extractor.ResolverFileView{})
	if err != nil {
		t.Fatalf("resolve Go page: %v", err)
	}

	helperID := findNodeID(t, contribution.Facts(), FunctionNodeKind, "helper")
	mainID := findNodeID(t, contribution.Facts(), FunctionNodeKind, "main")
	if !hasFactEdge(resolution.Facts(), mainID, helperID, CallsRelation) {
		t.Errorf("resolved facts = %+v, want local call fact", resolution.Facts())
	}
}

func TestResolveWithFileViewResolvesLocalMethodSelectorCalls(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/store.go",
		Contents:   []byte("package fixture\n\ntype Store struct{}\n\nfunc (Store) LookupNodes() {}\n\nfunc run(store Store) { store.LookupNodes() }\n"),
	})
	if err != nil {
		t.Fatalf("extract Go facts: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{contribution}, extractor.ResolverFileView{})
	if err != nil {
		t.Fatalf("resolve Go facts: %v", err)
	}

	runID := findNodeID(t, contribution.Facts(), FunctionNodeKind, "run")
	methodID := findNodeID(t, contribution.Facts(), MethodNodeKind, "LookupNodes")
	if !hasFactEdge(resolution.Facts(), runID, methodID, CallsRelation) {
		t.Errorf("resolved facts = %+v, want method call fact", resolution.Facts())
	}
}

func TestResolversResolveMethodSelectorCallsByReceiverType(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/methods.go",
		Contents:   []byte("package fixture\n\ntype Alpha struct{}\ntype Beta struct{}\n\nfunc (Alpha) Run() {}\nfunc (*Beta) Run() {}\n\nfunc invoke() {\n\talpha := Alpha{}\n\tbeta := &Beta{}\n\talpha.Run()\n\tbeta.Run()\n}\n"),
	})
	if err != nil {
		t.Fatalf("extract Go facts: %v", err)
	}

	invokeID := findNodeID(t, contribution.Facts(), FunctionNodeKind, "invoke")
	alphaRunID := findNodeIDBySpan(t, contribution.Facts(), MethodNodeKind, "Run", graph.SourceSpan{Path: "src/methods.go", StartLine: 6, StartColumn: 1, EndLine: 6, EndColumn: 22})
	betaRunID := findNodeIDBySpan(t, contribution.Facts(), MethodNodeKind, "Run", graph.SourceSpan{Path: "src/methods.go", StartLine: 7, StartColumn: 1, EndLine: 7, EndColumn: 22})
	for _, testCase := range []struct {
		name    string
		resolve func() (Resolution, error)
	}{
		{
			name: "file view",
			resolve: func() (Resolution, error) {
				return ResolveWithFileView([]extractor.Contribution{contribution}, extractor.ResolverFileView{})
			},
		},
		{
			name: "page",
			resolve: func() (Resolution, error) {
				return ResolvePage(context.Background(), []extractor.Contribution{contribution}, "project:fixture", pageResolverIndex{}, extractor.ResolverFileView{})
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			resolution, err := testCase.resolve()
			if err != nil {
				t.Fatalf("resolve Go facts: %v", err)
			}
			if !hasFactEdge(resolution.Facts(), invokeID, alphaRunID, CallsRelation) {
				t.Errorf("resolved facts = %+v, want call to Alpha.Run", resolution.Facts())
			}
			if !hasFactEdge(resolution.Facts(), invokeID, betaRunID, CallsRelation) {
				t.Errorf("resolved facts = %+v, want call to Beta.Run", resolution.Facts())
			}

			callCount := 0
			for _, edge := range resolution.Facts().Edges {
				if edge.SourceID == invokeID && edge.Relation == CallsRelation {
					callCount++
				}
			}
			if callCount != 2 {
				t.Errorf("method call count = %d, want 2", callCount)
			}
		})
	}
}

func TestResolveWithFileViewReportsUnsupportedLocalMethodReceiver(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/methods.go",
		Contents:   []byte("package fixture\n\ntype Store struct{}\n\nfunc (Store) Run() {}\n\nfunc source() any { return nil }\n\nfunc invoke() {\n\tvalue := source()\n\tvalue.Run()\n}\n"),
	})
	if err != nil {
		t.Fatalf("extract Go facts: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{contribution}, extractor.ResolverFileView{})
	if err != nil {
		t.Fatalf("resolve Go facts: %v", err)
	}

	invokeID := findNodeID(t, contribution.Facts(), FunctionNodeKind, "invoke")
	storeRunID := findNodeID(t, contribution.Facts(), MethodNodeKind, "Run")
	if hasFactEdge(resolution.Facts(), invokeID, storeRunID, CallsRelation) {
		t.Errorf("resolved facts = %+v, must not add a speculative Store.Run call", resolution.Facts())
	}
	for _, diagnostic := range resolution.Diagnostics() {
		if diagnostic.Message == `Go call "value.Run" from "src/methods.go" is unsupported or ambiguous` {
			return
		}
	}
	t.Errorf("diagnostics = %+v, want unsupported receiver diagnostic", resolution.Diagnostics())
}

func TestExtractScopesLocalVariableReferencesToTheirFunction(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/values.go",
		Contents:   []byte("package fixture\n\nfunc first() int {\n\tvalue := 1\n\treturn value\n}\n\nfunc second() int {\n\tvalue := 2\n\treturn value\n}\n"),
	})
	if err != nil {
		t.Fatalf("extract Go facts: %v", err)
	}

	firstID := findNodeID(t, contribution.Facts(), FunctionNodeKind, "first")
	secondID := findNodeID(t, contribution.Facts(), FunctionNodeKind, "second")
	firstValueID := findNodeIDBySpan(t, contribution.Facts(), VariableNodeKind, "value", graph.SourceSpan{Path: "src/values.go", StartLine: 4, StartColumn: 2, EndLine: 4, EndColumn: 7})
	secondValueID := findNodeIDBySpan(t, contribution.Facts(), VariableNodeKind, "value", graph.SourceSpan{Path: "src/values.go", StartLine: 9, StartColumn: 2, EndLine: 9, EndColumn: 7})
	if !hasFactEdge(contribution.Facts(), firstID, firstValueID, "references") {
		t.Errorf("facts = %+v, want first reference to first value", contribution.Facts())
	}
	if !hasFactEdge(contribution.Facts(), secondID, secondValueID, "references") {
		t.Errorf("facts = %+v, want second reference to second value", contribution.Facts())
	}
}

func TestExtractSkipsBlankIdentifierVariables(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/blank.go",
		Contents:   []byte("package fixture\n\nfunc value() int {\n\t_, result := 1, 2\n\treturn result\n}\n"),
	})
	if err != nil {
		t.Fatalf("extract Go facts: %v", err)
	}

	for _, node := range contribution.Facts().Nodes {
		if node.Kind == VariableNodeKind && node.Label == "_" {
			t.Errorf("facts = %+v, must not declare blank identifier", contribution.Facts())
		}
	}
	findNodeID(t, contribution.Facts(), VariableNodeKind, "result")
}

func TestResolveWithFileViewResolvesModuleLocalImport(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "internal/helper/helper.go",
		Contents:   []byte("package helper\n\nconst DefaultLimit = 10\n\nfunc Help() {}\n"),
	})
	if err != nil {
		t.Fatalf("extract helper Go facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "cmd/main.go",
		Contents:   []byte("package main\n\nimport \"example.com/fixture/internal/helper\"\n\nfunc Main() { helper.Help() }\n"),
	})
	if err != nil {
		t.Fatalf("extract main Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"go.mod": []byte("module example.com/fixture\n"),
	})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main, helper}, view)
	if err != nil {
		t.Fatalf("resolve Go imports: %v", err)
	}
	mainFileID := findNodeID(t, main.Facts(), "file", "cmd/main.go")
	helperFileID := findNodeID(t, helper.Facts(), "file", "internal/helper/helper.go")
	helperID := findNodeID(t, helper.Facts(), FunctionNodeKind, "Help")
	defaultLimitID := findNodeID(t, helper.Facts(), ConstantNodeKind, "DefaultLimit")
	if !hasFactEdge(resolution.Facts(), mainFileID, helperFileID, ImportsFromRelation) {
		t.Errorf("facts = %+v, want package import fact", resolution.Facts())
	}
	if !hasFactEdge(resolution.Facts(), mainFileID, helperID, ImportsFromRelation) {
		t.Errorf("facts = %+v, want imported exported surface fact", resolution.Facts())
	}
	if !hasFactEdge(resolution.Facts(), mainFileID, defaultLimitID, ImportsFromRelation) {
		t.Errorf("facts = %+v, want imported exported constant fact", resolution.Facts())
	}
}

func TestResolveWithFileViewResolvesReplacementModule(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "third_party/helper/api/helper.go",
		Contents:   []byte("package api\n\nfunc Help() {}\n"),
	})
	if err != nil {
		t.Fatalf("extract replacement helper Go facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "cmd/main.go",
		Contents:   []byte("package main\n\nimport \"example.com/helper/api\"\n\nfunc Main() { api.Help() }\n"),
	})
	if err != nil {
		t.Fatalf("extract main Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"go.mod": []byte("module example.com/fixture\n\nreplace example.com/helper => ./third_party/helper\n"),
	})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main, helper}, view)
	if err != nil {
		t.Fatalf("resolve Go imports: %v", err)
	}
	mainID := findNodeID(t, main.Facts(), FunctionNodeKind, "Main")
	helperID := findNodeID(t, helper.Facts(), FunctionNodeKind, "Help")
	if !hasFactEdge(resolution.Facts(), mainID, helperID, CallsRelation) {
		t.Errorf("facts = %+v, want Main to call replacement-module Help", resolution.Facts())
	}
}

func TestResolvePageResolvesWorkspaceMember(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "modules/helper/api/helper.go",
		Contents:   []byte("package api\n\nfunc Help() {}\n"),
	})
	if err != nil {
		t.Fatalf("extract workspace helper Go facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "cmd/main.go",
		Contents:   []byte("package main\n\nimport \"example.com/helper/api\"\n\nfunc Main() { api.Help() }\n"),
	})
	if err != nil {
		t.Fatalf("extract main Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"go.mod":                []byte("module example.com/fixture\n"),
		"go.work":               []byte("go 1.27\n\nuse ./modules/helper\n"),
		"modules/helper/go.mod": []byte("module example.com/helper\n"),
	})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}

	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{main}, "project:fixture", pageResolverIndex{packages: map[string][]extractor.ResolverTarget{
		"modules/helper/api": {pageResolverTarget(helper)},
	}}, view)
	if err != nil {
		t.Fatalf("resolve Go page: %v", err)
	}
	mainID := findNodeID(t, main.Facts(), FunctionNodeKind, "Main")
	helperID := findNodeID(t, helper.Facts(), FunctionNodeKind, "Help")
	if !hasFactEdge(resolution.Facts(), mainID, helperID, CallsRelation) {
		t.Errorf("facts = %+v, want Main to call workspace-member Help", resolution.Facts())
	}
}

func TestResolvePageUsesResolverIndexForCrossPageImport(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "internal/helper/helper.go",
		Contents:   []byte("package helper\n\nfunc Help() {}\n"),
	})
	if err != nil {
		t.Fatalf("extract helper Go facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "cmd/main.go",
		Contents:   []byte("package main\n\nimport \"example.com/fixture/internal/helper\"\n\nfunc Main() { helper.Help() }\n"),
	})
	if err != nil {
		t.Fatalf("extract main Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{"go.mod": []byte("module example.com/fixture\n")})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}
	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{main}, "project:fixture", pageResolverIndex{packages: map[string][]extractor.ResolverTarget{
		"internal/helper": {pageResolverTarget(helper)},
	}}, view)
	if err != nil {
		t.Fatalf("resolve Go page: %v", err)
	}
	mainFileID := findNodeID(t, main.Facts(), "file", "cmd/main.go")
	helperFileID := findNodeID(t, helper.Facts(), "file", "internal/helper/helper.go")
	helperID := findNodeID(t, helper.Facts(), FunctionNodeKind, "Help")
	if !hasFactEdge(resolution.Facts(), mainFileID, helperFileID, ImportsFromRelation) {
		t.Errorf("facts = %+v, want indexed package import fact", resolution.Facts())
	}
	if !hasFactEdge(resolution.Facts(), mainFileID, helperID, ImportsFromRelation) {
		t.Errorf("facts = %+v, want indexed exported surface import fact", resolution.Facts())
	}
}

func TestResolvePageUsesResolverIndexForCrossPagePackageCall(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "internal/helper/helper.go",
		Contents:   []byte("package helper\n\nfunc Help() {}\n"),
	})
	if err != nil {
		t.Fatalf("extract helper Go facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "cmd/main.go",
		Contents:   []byte("package main\n\nimport \"example.com/fixture/internal/helper\"\n\nfunc Main() { helper.Help() }\n"),
	})
	if err != nil {
		t.Fatalf("extract main Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{"go.mod": []byte("module example.com/fixture\n")})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}
	reads := 0
	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{main}, "project:fixture", pageResolverIndex{
		packages: map[string][]extractor.ResolverTarget{
			"internal/helper": {pageResolverTarget(helper)},
		},
		packagePageReads: &reads,
	}, view)
	if err != nil {
		t.Fatalf("resolve Go page: %v", err)
	}
	mainID := findNodeID(t, main.Facts(), FunctionNodeKind, "Main")
	helperID := findNodeID(t, helper.Facts(), FunctionNodeKind, "Help")
	if !hasFactEdge(resolution.Facts(), mainID, helperID, CallsRelation) {
		t.Errorf("facts = %+v, want indexed package call fact", resolution.Facts())
	}
	if reads != 2 {
		t.Errorf("resolver package page reads = %d, want one data page and one terminal page", reads)
	}
}

func TestResolvePageUsesImportAliasForCrossPagePackageCall(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "internal/support/support.go",
		Contents:   []byte("package support\n\nfunc Run() {}\n"),
	})
	if err != nil {
		t.Fatalf("extract helper Go facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "cmd/main.go",
		Contents:   []byte("package main\n\nimport helper \"example.com/fixture/internal/support\"\n\nfunc Main() { helper.Run() }\n"),
	})
	if err != nil {
		t.Fatalf("extract main Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{"go.mod": []byte("module example.com/fixture\n")})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}

	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{main}, "project:fixture", pageResolverIndex{packages: map[string][]extractor.ResolverTarget{
		"internal/support": {pageResolverTarget(helper)},
	}}, view)
	if err != nil {
		t.Fatalf("resolve Go page: %v", err)
	}
	mainID := findNodeID(t, main.Facts(), FunctionNodeKind, "Main")
	helperID := findNodeID(t, helper.Facts(), FunctionNodeKind, "Run")
	if !hasFactEdge(resolution.Facts(), mainID, helperID, CallsRelation) {
		t.Errorf("facts = %+v, want indexed aliased package call", resolution.Facts())
	}
}

func TestResolvePageUsesResolverIndexForCrossPageInterfaceImplementation(t *testing.T) {
	contract, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "service/contract.go",
		Contents:   []byte("package service\n\ntype Runner interface {\n\tRun()\n}\n"),
	})
	if err != nil {
		t.Fatalf("extract contract Go facts: %v", err)
	}
	service, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "service/service.go",
		Contents:   []byte("package service\n\ntype Worker struct{}\n\nfunc (Worker) Run() {}\n"),
	})
	if err != nil {
		t.Fatalf("extract service Go facts: %v", err)
	}
	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{service}, "project:fixture", pageResolverIndex{packages: map[string][]extractor.ResolverTarget{
		"service": {pageResolverTarget(contract), pageResolverTarget(service)},
	}}, extractor.ResolverFileView{})
	if err != nil {
		t.Fatalf("resolve Go page: %v", err)
	}
	workerID := findNodeID(t, service.Facts(), StructNodeKind, "Worker")
	runnerID := findNodeID(t, contract.Facts(), InterfaceNodeKind, "Runner")
	if !hasFactEdge(resolution.Facts(), workerID, runnerID, ImplementsRelation) {
		t.Errorf("facts = %+v, want Worker to implement indexed Runner", resolution.Facts())
	}
}

func TestResolvePageUsesResolverIndexForCrossPageInterfaceEmbedding(t *testing.T) {
	base, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "service/base.go",
		Contents:   []byte("package service\n\ntype Reader interface {\n\tRead()\n}\n"),
	})
	if err != nil {
		t.Fatalf("extract base Go facts: %v", err)
	}
	combined, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "service/combined.go",
		Contents:   []byte("package service\n\ntype ReadWriter interface {\n\tReader\n\tWrite()\n}\n"),
	})
	if err != nil {
		t.Fatalf("extract combined Go facts: %v", err)
	}
	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{combined}, "project:fixture", pageResolverIndex{packages: map[string][]extractor.ResolverTarget{
		"service": {pageResolverTarget(base), pageResolverTarget(combined)},
	}}, extractor.ResolverFileView{})
	if err != nil {
		t.Fatalf("resolve Go page: %v", err)
	}
	readWriterID := findNodeID(t, combined.Facts(), InterfaceNodeKind, "ReadWriter")
	readerID := findNodeID(t, base.Facts(), InterfaceNodeKind, "Reader")
	if !hasFactEdge(resolution.Facts(), readWriterID, readerID, EmbedsRelation) {
		t.Errorf("facts = %+v, want ReadWriter to embed indexed Reader", resolution.Facts())
	}
}

type pageResolverIndex struct {
	packages         map[string][]extractor.ResolverTarget
	packagePageReads *int
}

func (index pageResolverIndex) ResolverTarget(context.Context, extractor.ResolverTargetRequest) (extractor.ResolverTarget, bool, error) {
	return extractor.ResolverTarget{}, false, nil
}

func (index pageResolverIndex) ResolverPackagePage(_ context.Context, request extractor.ResolverPackagePageRequest) ([]extractor.ResolverTarget, error) {
	if index.packagePageReads != nil {
		*index.packagePageReads++
	}
	targets := make([]extractor.ResolverTarget, 0, request.Limit)
	for _, target := range index.packages[request.PackagePath] {
		if target.SourcePath <= request.AfterSourcePath {
			continue
		}
		targets = append(targets, target)
		if len(targets) == request.Limit {
			break
		}
	}
	return targets, nil
}

func pageResolverTarget(contribution extractor.Contribution) extractor.ResolverTarget {
	return extractor.ResolverTarget{
		ProjectID:            "project:fixture",
		SourcePath:           contribution.SourcePath(),
		Metadata:             contribution.Metadata(),
		Nodes:                contribution.Facts().Nodes,
		UnresolvedReferences: contribution.UnresolvedReferences(),
		SymbolReferences:     contribution.SymbolReferences(),
		ExportedSurfaces:     contribution.ExportedSurfaces(),
		Diagnostics:          contribution.Diagnostics(),
	}
}

func TestResolveWithFileViewAddsCrossFileInterfaceImplementation(t *testing.T) {
	contract, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "service/contract.go",
		Contents:   []byte("package service\n\ntype Runner interface {\n\tRun()\n}\n"),
	})
	if err != nil {
		t.Fatalf("extract contract Go facts: %v", err)
	}
	service, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "service/service.go",
		Contents:   []byte("package service\n\ntype Worker struct{}\n\nfunc (Worker) Run() {}\n"),
	})
	if err != nil {
		t.Fatalf("extract service Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"go.mod": []byte("module example.com/fixture\n"),
	})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{service, contract}, view)
	if err != nil {
		t.Fatalf("resolve Go relationships: %v", err)
	}
	workerID := findNodeID(t, service.Facts(), StructNodeKind, "Worker")
	runnerID := findNodeID(t, contract.Facts(), InterfaceNodeKind, "Runner")
	if !hasFactEdge(resolution.Facts(), workerID, runnerID, ImplementsRelation) {
		t.Errorf("facts = %+v, want Worker to implement Runner", resolution.Facts())
	}
}

func TestResolveWithFileViewAddsCrossFileInterfaceEmbedding(t *testing.T) {
	base, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "service/base.go",
		Contents:   []byte("package service\n\ntype Reader interface {\n\tRead()\n}\n"),
	})
	if err != nil {
		t.Fatalf("extract base Go facts: %v", err)
	}
	combined, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "service/combined.go",
		Contents:   []byte("package service\n\ntype ReadWriter interface {\n\tReader\n\tWrite()\n}\n"),
	})
	if err != nil {
		t.Fatalf("extract combined Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"go.mod": []byte("module example.com/fixture\n"),
	})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{combined, base}, view)
	if err != nil {
		t.Fatalf("resolve Go relationships: %v", err)
	}
	readWriterID := findNodeID(t, combined.Facts(), InterfaceNodeKind, "ReadWriter")
	readerID := findNodeID(t, base.Facts(), InterfaceNodeKind, "Reader")
	if !hasFactEdge(resolution.Facts(), readWriterID, readerID, EmbedsRelation) {
		t.Errorf("facts = %+v, want ReadWriter to embed Reader", resolution.Facts())
	}
}

func TestResolveWithFileViewAddsCrossFilePackageCall(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "internal/helper/helper.go",
		Contents:   []byte("package helper\n\nfunc Help() {}\n"),
	})
	if err != nil {
		t.Fatalf("extract helper Go facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "cmd/main.go",
		Contents:   []byte("package main\n\nimport \"example.com/fixture/internal/helper\"\n\nfunc Main() { helper.Help() }\n"),
	})
	if err != nil {
		t.Fatalf("extract main Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"go.mod": []byte("module example.com/fixture\n"),
	})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main, helper}, view)
	if err != nil {
		t.Fatalf("resolve Go relationships: %v", err)
	}
	mainID := findNodeID(t, main.Facts(), FunctionNodeKind, "Main")
	helperID := findNodeID(t, helper.Facts(), FunctionNodeKind, "Help")
	if !hasFactEdge(resolution.Facts(), mainID, helperID, CallsRelation) {
		t.Errorf("facts = %+v, want Main to call Help", resolution.Facts())
	}
}

func TestResolveWithFileViewUsesImportAliasForPackageCall(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "internal/support/support.go",
		Contents:   []byte("package support\n\nfunc Run() {}\n"),
	})
	if err != nil {
		t.Fatalf("extract helper Go facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "cmd/main.go",
		Contents:   []byte("package main\n\nimport helper \"example.com/fixture/internal/support\"\n\nfunc Main() { helper.Run() }\n"),
	})
	if err != nil {
		t.Fatalf("extract main Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"go.mod": []byte("module example.com/fixture\n"),
	})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main, helper}, view)
	if err != nil {
		t.Fatalf("resolve Go relationships: %v", err)
	}
	mainID := findNodeID(t, main.Facts(), FunctionNodeKind, "Main")
	helperID := findNodeID(t, helper.Facts(), FunctionNodeKind, "Run")
	if !hasFactEdge(resolution.Facts(), mainID, helperID, CallsRelation) {
		t.Errorf("facts = %+v, want Main to call Run through the import alias", resolution.Facts())
	}
	if diagnostics := resolution.Diagnostics(); len(diagnostics) != 0 {
		t.Errorf("diagnostics = %+v, want none for a resolved aliased package call", diagnostics)
	}
}

func TestResolveWithFileViewUsesTargetPackageNameForPackageCall(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "internal/package_name_differs/worker.go",
		Contents:   []byte("package worker\n\nfunc Run() {}\n"),
	})
	if err != nil {
		t.Fatalf("extract helper Go facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "cmd/main.go",
		Contents:   []byte("package main\n\nimport \"example.com/fixture/internal/package_name_differs\"\n\nfunc Main() { worker.Run() }\n"),
	})
	if err != nil {
		t.Fatalf("extract main Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"go.mod": []byte("module example.com/fixture\n"),
	})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main, helper}, view)
	if err != nil {
		t.Fatalf("resolve Go relationships: %v", err)
	}
	mainID := findNodeID(t, main.Facts(), FunctionNodeKind, "Main")
	helperID := findNodeID(t, helper.Facts(), FunctionNodeKind, "Run")
	if !hasFactEdge(resolution.Facts(), mainID, helperID, CallsRelation) {
		t.Errorf("facts = %+v, want Main to call Run through the declared package name", resolution.Facts())
	}
}

func TestResolveWithFileViewReportsUnsupportedPackageTypeCall(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "internal/helper/helper.go",
		Contents:   []byte("package helper\n\ntype Factory struct{}\n"),
	})
	if err != nil {
		t.Fatalf("extract helper Go facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "cmd/main.go",
		Contents:   []byte("package main\n\nimport \"example.com/fixture/internal/helper\"\n\nfunc Main() { helper.Factory() }\n"),
	})
	if err != nil {
		t.Fatalf("extract main Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"go.mod": []byte("module example.com/fixture\n"),
	})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main, helper}, view)
	if err != nil {
		t.Fatalf("resolve Go relationships: %v", err)
	}
	mainID := findNodeID(t, main.Facts(), FunctionNodeKind, "Main")
	if hasCallEdgeFrom(resolution.Facts(), mainID) {
		t.Errorf("facts = %+v, want no call edge for a non-callable package target", resolution.Facts())
	}
	for _, diagnostic := range resolution.Diagnostics() {
		if diagnostic.Message == `Go call "helper.Factory" from "cmd/main.go" is unsupported or ambiguous` {
			return
		}
	}
	t.Errorf("diagnostics = %+v, want unsupported package type call diagnostic", resolution.Diagnostics())
}

func TestResolveWithFileViewReportsUnsupportedReceiverDispatch(t *testing.T) {
	service, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "service/service.go",
		Contents:   []byte("package service\n\ntype Worker struct{}\n\nfunc (Worker) Run() {}\n\nfunc Start() {\n\tworker := Worker{}\n\tworker.Run()\n}\n"),
	})
	if err != nil {
		t.Fatalf("extract service Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"go.mod": []byte("module example.com/fixture\n"),
	})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{service}, view)
	if err != nil {
		t.Fatalf("resolve Go relationships: %v", err)
	}
	for _, diagnostic := range resolution.Diagnostics() {
		if diagnostic.Message == `Go call "worker.Run" from "service/service.go" is unsupported or ambiguous` {
			return
		}
	}
	t.Errorf("diagnostics = %+v, want unsupported receiver dispatch diagnostic", resolution.Diagnostics())
}

func TestResolveWithFileViewReportsAmbiguousPackageCall(t *testing.T) {
	first, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "internal/helper/first.go",
		Contents:   []byte("package helper\n\nfunc Help() {}\n"),
	})
	if err != nil {
		t.Fatalf("extract first helper Go facts: %v", err)
	}
	second, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "internal/helper/second.go",
		Contents:   []byte("package helper\n\nfunc Help() {}\n"),
	})
	if err != nil {
		t.Fatalf("extract second helper Go facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "cmd/main.go",
		Contents:   []byte("package main\n\nimport \"example.com/fixture/internal/helper\"\n\nfunc Main() { helper.Help() }\n"),
	})
	if err != nil {
		t.Fatalf("extract main Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"go.mod": []byte("module example.com/fixture\n"),
	})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main, first, second}, view)
	if err != nil {
		t.Fatalf("resolve Go relationships: %v", err)
	}
	mainID := findNodeID(t, main.Facts(), FunctionNodeKind, "Main")
	if hasCallEdgeFrom(resolution.Facts(), mainID) {
		t.Errorf("facts = %+v, want no call edge for ambiguous package targets", resolution.Facts())
	}
	for _, diagnostic := range resolution.Diagnostics() {
		if diagnostic.Message == `Go call "helper.Help" from "cmd/main.go" is unsupported or ambiguous` {
			return
		}
	}
	t.Errorf("diagnostics = %+v, want ambiguous package call diagnostic", resolution.Diagnostics())
}

func TestResolveWithFileViewKeepsExternalImportsOutOfLocalFacts(t *testing.T) {
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "cmd/main.go",
		Contents:   []byte("package main\n\nimport \"fmt\"\n\nfunc Main() { fmt.Println(\"fixture\") }\n"),
	})
	if err != nil {
		t.Fatalf("extract main Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"go.mod": []byte("module example.com/fixture\n"),
	})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main}, view)
	if err != nil {
		t.Fatalf("resolve Go imports: %v", err)
	}
	if len(resolution.Facts().Edges) != 0 {
		t.Errorf("facts = %+v, want no local import facts for standard library package", resolution.Facts())
	}
	if len(resolution.Diagnostics()) != 0 {
		t.Errorf("diagnostics = %+v, want no external package diagnostic", resolution.Diagnostics())
	}
}

func TestResolvePageKeepsExternalImportsOutOfLocalFacts(t *testing.T) {
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "cmd/main.go",
		Contents:   []byte("package main\n\nimport \"fmt\"\n\nfunc Main() { fmt.Println(\"fixture\") }\n"),
	})
	if err != nil {
		t.Fatalf("extract main Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"go.mod": []byte("module example.com/fixture\n"),
	})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}

	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{main}, "project:fixture", pageResolverIndex{}, view)
	if err != nil {
		t.Fatalf("resolve Go imports: %v", err)
	}
	if len(resolution.Facts().Edges) != 0 {
		t.Errorf("facts = %+v, want no local import facts for standard library package", resolution.Facts())
	}
	if len(resolution.Diagnostics()) != 0 {
		t.Errorf("diagnostics = %+v, want no external package diagnostic", resolution.Diagnostics())
	}
}

func TestResolveWithFileViewKeepsUnmappedExternalModuleOutOfLocalFacts(t *testing.T) {
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "cmd/main.go",
		Contents:   []byte("package main\n\nimport \"example.com/external/helper\"\n\nfunc Main() { helper.Run() }\n"),
	})
	if err != nil {
		t.Fatalf("extract main Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"go.mod": []byte("module example.com/fixture\n"),
	})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main}, view)
	if err != nil {
		t.Fatalf("resolve Go imports: %v", err)
	}
	if len(resolution.Facts().Edges) != 0 {
		t.Errorf("facts = %+v, want no local facts for an unmapped external module", resolution.Facts())
	}
	if len(resolution.Diagnostics()) != 0 {
		t.Errorf("diagnostics = %+v, want no unmapped external module diagnostic", resolution.Diagnostics())
	}
}

func TestResolveWithFileViewReportsUnresolvedModuleLocalPackage(t *testing.T) {
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "cmd/main.go",
		Contents:   []byte("package main\n\nimport \"example.com/fixture/missing\"\n"),
	})
	if err != nil {
		t.Fatalf("extract main Go facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"go.mod": []byte("module example.com/fixture\n"),
	})
	if err != nil {
		t.Fatalf("create resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main}, view)
	if err != nil {
		t.Fatalf("resolve Go imports: %v", err)
	}
	for _, diagnostic := range resolution.Diagnostics() {
		if diagnostic.Message == `Go package "example.com/fixture/missing" from "cmd/main.go" is not indexed` {
			return
		}
	}
	t.Errorf("diagnostics = %+v, want unresolved package diagnostic", resolution.Diagnostics())
}

func findNodeID(t *testing.T, facts graph.Facts, kind graph.NodeKind, label string) string {
	t.Helper()
	for _, node := range facts.Nodes {
		if node.Kind == kind && node.Label == label {
			return node.ID
		}
	}
	t.Fatalf("facts = %+v, want node %s %q", facts, kind, label)
	return ""
}

func findNodeIDBySpan(t *testing.T, facts graph.Facts, kind graph.NodeKind, label string, span graph.SourceSpan) string {
	t.Helper()
	for _, node := range facts.Nodes {
		if node.Kind == kind && node.Label == label && node.Evidence.Span == span {
			return node.ID
		}
	}
	t.Fatalf("facts = %+v, want node %s %q at %+v", facts, kind, label, span)
	return ""
}

func hasFactEdge(facts graph.Facts, sourceID, targetID string, relation graph.RelationKind) bool {
	for _, edge := range facts.Edges {
		if edge.SourceID == sourceID && edge.TargetID == targetID && edge.Relation == relation {
			return true
		}
	}
	return false
}

func hasCallEdgeFrom(facts graph.Facts, sourceID string) bool {
	for _, edge := range facts.Edges {
		if edge.SourceID == sourceID && edge.Relation == CallsRelation {
			return true
		}
	}
	return false
}

func hasReferenceEvidence(facts graph.Facts, sourceID, targetID string, span graph.SourceSpan) bool {
	for _, edge := range facts.Edges {
		if edge.SourceID == sourceID && edge.TargetID == targetID && edge.Relation == "references" && edge.Evidence.Span == span {
			return true
		}
	}
	return false
}
