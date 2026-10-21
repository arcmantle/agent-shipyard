package javascript

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
	"agent-wayfinder/testkit"

	sitter "github.com/tree-sitter/go-tree-sitter"
)

func TestWorkerExtractsJSXWithKeywordAttributes(t *testing.T) {
	worker, err := NewWorker()
	if err != nil {
		t.Fatalf("create JavaScript worker: %v", err)
	}
	t.Cleanup(func() { _ = worker.Close() })
	for _, sourcePath := range []string{"src/page.jsx", "src/page.js", "src/page.JSX", "src/page.jsx"} {
		t.Run(sourcePath, func(t *testing.T) {
			contents := "export function Page() { return <VIEW break default class=\"page\" />; }"
			if strings.HasSuffix(sourcePath, ".js") {
				contents = "export function Page() { return 1; }"
			}
			contribution, err := worker.Extract(extractor.Source{
				ProjectID: "project:fixture", SourcePath: sourcePath, Contents: []byte(contents),
			})
			if err != nil {
				t.Fatalf("extract source: %v", err)
			}
			facts := contribution.Facts()
			if len(facts.Nodes) != 3 || facts.Nodes[2].Kind != FunctionNodeKind || facts.Nodes[2].Label != "Page" {
				t.Errorf("extracted nodes = %+v, want project, file, and Page function", facts.Nodes)
			}
		})
	}
}

func TestExtractRejectsInvalidJSXSnapshotWithLocation(t *testing.T) {
	_, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/__snapshots__/example.jsx",
		Contents:   []byte("<DOCUMENT>\n  <VIEW break />\n  <Table transformer={[object Object]} />\n</DOCUMENT>\n"),
	})
	if err == nil || !strings.Contains(err.Error(), `parse JavaScript source "src/__snapshots__/example.jsx" at 3:`) {
		t.Errorf("extract error = %v, want parse error at the invalid snapshot value", err)
	}
}

func TestExtractRejectsTypeScriptSyntaxInJSX(t *testing.T) {
	for _, contents := range []string{
		"const value: string = 'text';",
		"const value = text as string;",
		"const page = <Page<string> />;",
		"interface Page { name: string; }",
		"abstract class Page {}",
	} {
		t.Run(contents, func(t *testing.T) {
			_, err := Extract(extractor.Source{
				ProjectID: "project:fixture", SourcePath: "src/page.jsx", Contents: []byte(contents + "\nconst pageWithBreak = <Page break />;"),
			})
			if err == nil {
				t.Fatal("TypeScript-only syntax was accepted in a JSX source")
			}
		})
	}
}

func TestExtractJSXPreservesJavaScriptFacts(t *testing.T) {
	contents := "import { helper } from './helper';\nexport class Page { render() { return helper(); } }\nexport const page = <Page />;\n"
	var contributions []extractor.Contribution
	for _, sourcePath := range []string{"src/page.js", "src/page.jsx"} {
		sourceContents := contents
		if strings.HasSuffix(sourcePath, ".jsx") {
			sourceContents = strings.Replace(contents, "<Page />", "<Page break />", 1)
		}
		contribution, err := Extract(extractor.Source{
			ProjectID: "project:fixture", SourcePath: sourcePath, Contents: []byte(sourceContents),
		})
		if err != nil {
			t.Fatalf("extract %s: %v", sourcePath, err)
		}
		contributions = append(contributions, contribution)
	}
	javascriptFacts := contributions[0].Facts()
	jsxFacts := contributions[1].Facts()
	if len(javascriptFacts.Nodes) != len(jsxFacts.Nodes) || len(javascriptFacts.Edges) != len(jsxFacts.Edges) {
		t.Fatalf("JavaScript facts = %+v, JSX facts = %+v, want matching counts", javascriptFacts, jsxFacts)
	}
	for nodeIndex, javascriptNode := range javascriptFacts.Nodes {
		jsxNode := jsxFacts.Nodes[nodeIndex]
		if javascriptNode.Kind != jsxNode.Kind || (javascriptNode.Kind != "file" && javascriptNode.Label != jsxNode.Label) {
			t.Errorf("JavaScript node = %+v, JSX node = %+v", javascriptNode, jsxNode)
		}
	}
	for edgeIndex, javascriptEdge := range javascriptFacts.Edges {
		if javascriptEdge.Relation != jsxFacts.Edges[edgeIndex].Relation {
			t.Errorf("JavaScript edge = %+v, JSX edge = %+v", javascriptEdge, jsxFacts.Edges[edgeIndex])
		}
	}
	for contributionIndex, contribution := range contributions {
		if len(contribution.UnresolvedReferences()) != 1 || len(contribution.SymbolReferences()) != 1 || len(contribution.ExportedSurfaces()) != 3 {
			t.Errorf("contribution %d has different module, call, or export references", contributionIndex)
		}
	}
}

func TestLanguageParsesJavaScript(t *testing.T) {
	language := Language()

	parser := sitter.NewParser()
	defer parser.Close()
	if err := parser.SetLanguage(language); err != nil {
		t.Fatalf("set JavaScript language: %v", err)
	}

	tree := parser.Parse([]byte("export function greet(name) { return name; }"), nil)
	defer tree.Close()
	if tree.RootNode().HasError() {
		t.Fatal("JavaScript source has a syntax error")
	}
}

func TestWorkerExtractsSource(t *testing.T) {
	worker, err := NewWorker()
	if err != nil {
		t.Fatalf("create JavaScript worker: %v", err)
	}
	t.Cleanup(func() { _ = worker.Close() })

	contribution, err := worker.Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/greet.js",
		Contents:   []byte("export function greet(name) { return name; }"),
	})
	if err != nil {
		t.Fatalf("extract JavaScript source: %v", err)
	}
	if len(contribution.Facts().Nodes) == 0 {
		t.Error("extracted contribution has no nodes")
	}
}

func TestWorkerCloseDoesNotAffectOtherWorkers(t *testing.T) {
	closedWorker, err := NewWorker()
	if err != nil {
		t.Fatalf("create closed JavaScript worker: %v", err)
	}
	activeWorker, err := NewWorker()
	if err != nil {
		t.Fatalf("create active JavaScript worker: %v", err)
	}
	t.Cleanup(func() { _ = activeWorker.Close() })

	if err := closedWorker.Close(); err != nil {
		t.Fatalf("close JavaScript worker: %v", err)
	}
	source := extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/greet.js",
		Contents:   []byte("export function greet(name) { return name; }"),
	}
	if _, err := closedWorker.Extract(source); err == nil || err.Error() != "JavaScript worker is closed" {
		t.Errorf("closed worker extract error = %v, want JavaScript worker is closed", err)
	}
	if _, err := activeWorker.Extract(source); err != nil {
		t.Errorf("extract with independent JavaScript worker: %v", err)
	}
}

func TestWorkersExtractConcurrently(t *testing.T) {
	workers := make([]*Worker, 2)
	for workerIndex := range workers {
		worker, err := NewWorker()
		if err != nil {
			t.Fatalf("create JavaScript worker %d: %v", workerIndex, err)
		}
		workers[workerIndex] = worker
		t.Cleanup(func() { _ = worker.Close() })
	}

	start := make(chan struct{})
	var ready sync.WaitGroup
	var complete sync.WaitGroup
	errs := make(chan error, len(workers))
	for workerIndex, worker := range workers {
		ready.Add(1)
		complete.Add(1)
		go func(worker *Worker, workerIndex int) {
			defer complete.Done()
			ready.Done()
			<-start
			_, err := worker.Extract(extractor.Source{
				ProjectID:  "project:fixture",
				SourcePath: "src/greet-" + string(rune('a'+workerIndex)) + ".js",
				Contents:   []byte("export function greet(name) { return name; }"),
			})
			errs <- err
		}(worker, workerIndex)
	}
	ready.Wait()
	close(start)
	complete.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("extract concurrently: %v", err)
		}
	}
}

func TestExtractProducesLocalFactsWithEvidence(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/greet.js",
		Contents:   []byte("function greet(name) { return name; }"),
	})
	if err != nil {
		t.Fatalf("extract JavaScript facts: %v", err)
	}

	facts := contribution.Facts()
	if len(facts.Nodes) != 3 {
		t.Fatalf("node count = %d, want 3", len(facts.Nodes))
	}
	if len(facts.Edges) != 2 {
		t.Fatalf("edge count = %d, want 2", len(facts.Edges))
	}

	fileSpan := graph.SourceSpan{Path: "src/greet.js", StartLine: 1, StartColumn: 1, EndLine: 1, EndColumn: 38}
	functionSpan := graph.SourceSpan{Path: "src/greet.js", StartLine: 1, StartColumn: 1, EndLine: 1, EndColumn: 38}
	wantFileID := graph.NewNodeID("file", fileSpan)
	wantFunctionID := graph.NewNodeID(FunctionNodeKind, functionSpan)
	wantFileEvidence := graph.FactEvidence{
		Span:       fileSpan,
		FileHash:   "sha256:1d9565353f219b24174214dfd3ebaaffd7fdf6dfcfc0424423451540e76acf85",
		Extractor:  "javascript@v0",
		Provenance: "static",
		Confidence: graph.ConfidenceExtracted,
	}
	wantFunctionEvidence := graph.FactEvidence{
		Span:       functionSpan,
		FileHash:   "sha256:1d9565353f219b24174214dfd3ebaaffd7fdf6dfcfc0424423451540e76acf85",
		Extractor:  "javascript@v0",
		Provenance: "static",
		Confidence: graph.ConfidenceExtracted,
	}

	if got := facts.Nodes[0]; got.ID != "project:fixture" || got.Kind != "project" || got.Label != "project:fixture" || got.QualifiedName != "project:fixture" {
		t.Errorf("project node = %+v, want project query names", got)
	}
	if got := facts.Nodes[1]; got.ID != wantFileID || got.Kind != "file" || got.Label != "src/greet.js" || got.QualifiedName != "src/greet.js" || got.Evidence != wantFileEvidence {
		t.Errorf("file node = %+v, want ID %q with query names and evidence %+v", got, wantFileID, wantFileEvidence)
	}
	if got := facts.Nodes[2]; got.ID != wantFunctionID || got.Kind != FunctionNodeKind || got.Label != "greet" || got.QualifiedName != "src/greet.js::greet" || got.Evidence != wantFunctionEvidence {
		t.Errorf("function node = %+v, want ID %q with query names and evidence %+v", got, wantFunctionID, wantFunctionEvidence)
	}
	if got := facts.Edges[0]; got.SourceID != "project:fixture" || got.TargetID != wantFileID || got.Relation != "contains" || got.Evidence != wantFileEvidence {
		t.Errorf("containment edge = %+v", got)
	}
	if got := facts.Edges[1]; got.SourceID != wantFileID || got.TargetID != wantFunctionID || got.Relation != "defines" || got.Evidence != wantFunctionEvidence {
		t.Errorf("definition edge = %+v", got)
	}
}

func TestResolveMarksBoundedDynamicRequireCandidatesAmbiguous(t *testing.T) {
	first, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/first.js",
		Contents:   []byte("export const first = 1;"),
	})
	if err != nil {
		t.Fatalf("extract first facts: %v", err)
	}
	second, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/second.js",
		Contents:   []byte("export const second = 2;"),
	})
	if err != nil {
		t.Fatalf("extract second facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.cjs",
		Contents:   []byte("const support = require(enabled ? './first' : './second');"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{main, first, second})
	if err != nil {
		t.Fatalf("resolve JavaScript requires: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	for _, target := range []string{first.Facts().Nodes[1].ID, second.Facts().Nodes[1].ID} {
		if !hasRelationWithConfidence(resolution.Facts().Edges, mainFileID, target, ImportsFromRelation, graph.ConfidenceAmbiguous) {
			t.Errorf("resolved facts = %+v, want ambiguous require edge from %q to %q", resolution.Facts(), mainFileID, target)
		}
	}
}

func TestExtractProducesLocalReferencesWithIdentifierEvidence(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/greet.js",
		Contents: []byte("function greet(name) { return helper(name); }\n" +
			"function helper(name) { return name; }\n"),
	})
	if err != nil {
		t.Fatalf("extract JavaScript facts: %v", err)
	}

	facts := contribution.Facts()
	if len(facts.Nodes) != 4 {
		t.Fatalf("node count = %d, want 4", len(facts.Nodes))
	}
	if len(facts.Edges) != 4 {
		t.Fatalf("edge count = %d, want 4", len(facts.Edges))
	}

	file := facts.Nodes[1]
	greet := facts.Nodes[2]
	helper := facts.Nodes[3]
	if file.Evidence.Span == greet.Evidence.Span {
		t.Errorf("file span = %+v, want a distinct full-file span", file.Evidence.Span)
	}
	if greet.Evidence.Span.StartLine != 1 || helper.Evidence.Span.StartLine != 2 {
		t.Errorf("function declaration spans = %+v, %+v, want lines 1 and 2", greet.Evidence.Span, helper.Evidence.Span)
	}

	reference := facts.Edges[3]
	if reference.SourceID != greet.ID || reference.TargetID != helper.ID || reference.Relation != "references" {
		t.Errorf("reference edge = %+v, want %q -> %q", reference, greet.ID, helper.ID)
	}
	if reference.Evidence.Span != (graph.SourceSpan{Path: "src/greet.js", StartLine: 1, StartColumn: 31, EndLine: 1, EndColumn: 37}) {
		t.Errorf("reference evidence span = %+v, want helper identifier span", reference.Evidence.Span)
	}
}

func TestExtractProvidesExportedSurfaceForNamedDeclaration(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.js",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract JavaScript facts: %v", err)
	}

	surfaces := contribution.ExportedSurfaces()
	if len(surfaces) != 1 {
		t.Fatalf("exported surface count = %d, want 1", len(surfaces))
	}
	if surfaces[0].Name != "helper" || surfaces[0].NodeID != contribution.Facts().Nodes[2].ID {
		t.Errorf("exported surface = %+v, want helper for %q", surfaces[0], contribution.Facts().Nodes[2].ID)
	}
}

func TestExtractProvidesStaticCommonJSRequireForResolution(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.cjs",
		Contents:   []byte("const support = require('example-package');"),
	})
	if err != nil {
		t.Fatalf("extract JavaScript facts: %v", err)
	}

	references := contribution.UnresolvedReferences()
	if len(references) != 1 {
		t.Fatalf("unresolved reference count = %d, want 1", len(references))
	}
	if got := references[0].Target; got != "example-package" {
		t.Errorf("require target = %q, want %q", got, "example-package")
	}
	if got := references[0].Kind; got != extractor.ModuleReferenceRequire {
		t.Errorf("require kind = %q, want %q", got, extractor.ModuleReferenceRequire)
	}
}

func TestExtractProvidesConstantDynamicImportForResolution(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.mjs",
		Contents:   []byte("const support = import('./support');"),
	})
	if err != nil {
		t.Fatalf("extract JavaScript facts: %v", err)
	}

	references := contribution.UnresolvedReferences()
	if len(references) != 1 {
		t.Fatalf("unresolved reference count = %d, want 1", len(references))
	}
	if got := references[0].Target; got != "./support" {
		t.Errorf("dynamic import target = %q, want %q", got, "./support")
	}
	if got := references[0].Kind; got != extractor.ModuleReferenceImport {
		t.Errorf("dynamic import kind = %q, want %q", got, extractor.ModuleReferenceImport)
	}
}

func TestExtractDoesNotTreatStringsInExportedDeclarationAsModuleReferences(t *testing.T) {
	sources := map[string]string{
		"class":         `export class Component { render() { return ["content"].join(""); } }`,
		"function":      `export function render() { return "content"; }`,
		"variable":      `export const content = "content";`,
		"default class": `export default class Component { render() { return "content"; } }`,
	}
	for name, contents := range sources {
		t.Run(name, func(t *testing.T) {
			contribution, err := Extract(extractor.Source{
				ProjectID:  "project:fixture",
				SourcePath: "src/component.js",
				Contents:   []byte(contents),
			})
			if err != nil {
				t.Fatalf("extract JavaScript facts: %v", err)
			}

			if references := contribution.UnresolvedReferences(); len(references) != 0 {
				t.Errorf("unresolved references = %+v, want none", references)
			}
		})
	}
}

func TestExtractReportsUnboundedDynamicRequire(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.cjs",
		Contents:   []byte("const support = require(moduleName);"),
	})
	if err != nil {
		t.Fatalf("extract JavaScript facts: %v", err)
	}

	if references := contribution.UnresolvedReferences(); len(references) != 0 {
		t.Errorf("unresolved references = %+v, want none", references)
	}
	if diagnostics := contribution.Diagnostics(); len(diagnostics) != 1 || !strings.Contains(diagnostics[0].Message, "is unbounded") {
		t.Errorf("diagnostics = %+v, want unbounded dynamic require diagnostic", diagnostics)
	}
}

func TestResolveWithFileViewUsesRequirePackageExport(t *testing.T) {
	packageEntry, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "node_modules/example-package/cjs.js",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract package entry facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.cjs",
		Contents:   []byte("const support = require('example-package');"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"node_modules/example-package/package.json": []byte(`{"exports":{"require":"./cjs.js","default":"./fallback.js"}}`),
	})
	if err != nil {
		t.Fatalf("new resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main, packageEntry}, view)
	if err != nil {
		t.Fatalf("resolve JavaScript package require: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	packageFileID := packageEntry.Facts().Nodes[1].ID
	if !hasRelation(resolution.Facts().Edges, mainFileID, packageFileID, ImportsFromRelation) {
		t.Errorf("resolved facts = %+v, want require edge from %q to %q", resolution.Facts(), mainFileID, packageFileID)
	}
}

func TestResolveWithFileViewUsesImportPackageExport(t *testing.T) {
	packageEntry, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "node_modules/example-package/esm.js",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract package entry facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.mjs",
		Contents:   []byte("import { helper } from 'example-package';"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"node_modules/example-package/package.json": []byte(`{"exports":{"import":"./esm.js","default":"./fallback.js"}}`),
	})
	if err != nil {
		t.Fatalf("new resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main, packageEntry}, view)
	if err != nil {
		t.Fatalf("resolve JavaScript package import: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	packageFileID := packageEntry.Facts().Nodes[1].ID
	if !hasRelation(resolution.Facts().Edges, mainFileID, packageFileID, ImportsFromRelation) {
		t.Errorf("resolved facts = %+v, want import edge from %q to %q", resolution.Facts(), mainFileID, packageFileID)
	}
}

func TestResolveWithFileViewUsesPackageSubpathWithoutExports(t *testing.T) {
	packageEntry, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "node_modules/example-package/sub.js",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract package entry facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.mjs",
		Contents:   []byte("import { helper } from 'example-package/sub';"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"node_modules/example-package/package.json": []byte(`{"main":"./main.js"}`),
	})
	if err != nil {
		t.Fatalf("new resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main, packageEntry}, view)
	if err != nil {
		t.Fatalf("resolve JavaScript package subpath: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	packageFileID := packageEntry.Facts().Nodes[1].ID
	if !hasRelation(resolution.Facts().Edges, mainFileID, packageFileID, ImportsFromRelation) {
		t.Errorf("resolved facts = %+v, want import edge from %q to %q", resolution.Facts(), mainFileID, packageFileID)
	}
}

func TestResolveAddsStaticImportRelation(t *testing.T) {
	support, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.js",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.js",
		Contents:   []byte("import { helper } from './support';\nexport const value = helper;"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{main, support})
	if err != nil {
		t.Fatalf("resolve JavaScript imports: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	supportFileID := support.Facts().Nodes[1].ID
	for _, edge := range resolution.Facts().Edges {
		if edge.SourceID == mainFileID && edge.TargetID == supportFileID && edge.Relation == "javascript:imports_from" {
			return
		}
	}
	t.Errorf("resolved facts = %+v, want import edge from %q to %q", resolution.Facts(), mainFileID, supportFileID)
}

func TestResolvePageUsesResolverIndexForCrossPageImport(t *testing.T) {
	support, err := Extract(extractor.Source{ProjectID: "project:fixture", SourcePath: "src/support.js", Contents: []byte("export const helper = 1;")})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	main, err := Extract(extractor.Source{ProjectID: "project:fixture", SourcePath: "src/main.js", Contents: []byte("import { helper } from './support'; export const value = helper;")})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}
	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{main}, "project:fixture", pageResolverIndex{targets: map[string]extractor.ResolverTarget{"src/support.js": pageResolverTarget(support)}})
	if err != nil {
		t.Fatalf("resolve JavaScript page: %v", err)
	}
	mainFileID := main.Facts().Nodes[1].ID
	supportFileID := support.Facts().Nodes[1].ID
	if hasPageResolvedEdge(resolution.Facts().Edges, mainFileID, supportFileID, ImportsFromRelation) == false {
		t.Errorf("resolved facts = %+v, want page import edge from %q to %q", resolution.Facts(), mainFileID, supportFileID)
	}
}

func TestResolvePageUsesWorkspacePackageImport(t *testing.T) {
	entry, err := Extract(extractor.Source{ProjectID: "project:packages/core", SourcePath: "packages/core/src/index.js", Contents: []byte("export const helper = 1;")})
	if err != nil {
		t.Fatalf("extract package entry facts: %v", err)
	}
	main, err := Extract(extractor.Source{ProjectID: "project:fixture", SourcePath: "src/main.js", Contents: []byte("import { helper } from '@scope/core';")})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{main}, "project:fixture", pageResolverIndex{
		packageTargets: map[string][]extractor.ResolverTarget{
			"packages/core/src": {pageResolverTarget(entry)},
		},
	})
	if err != nil {
		t.Fatalf("resolve JavaScript package page: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	entryFileID := entry.Facts().Nodes[1].ID
	entrySurfaceID := entry.ExportedSurfaces()[0].NodeID
	if !hasPageResolvedEdge(resolution.Facts().Edges, mainFileID, entryFileID, ImportsFromRelation) {
		t.Errorf("resolved facts = %+v, want package import edge from %q to %q", resolution.Facts(), mainFileID, entryFileID)
	}
	if !hasPageResolvedEdge(resolution.Facts().Edges, mainFileID, entrySurfaceID, ImportsFromRelation) {
		t.Errorf("resolved facts = %+v, want package export edge from %q to %q", resolution.Facts(), mainFileID, entrySurfaceID)
	}
}

func TestResolvePageResolvesImportAndCallThroughReExport(t *testing.T) {
	support, err := Extract(extractor.Source{ProjectID: "project:fixture", SourcePath: "src/support.js", Contents: []byte("export function left() {} export function right() {}")})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	barrel, err := Extract(extractor.Source{ProjectID: "project:fixture", SourcePath: "src/index.js", Contents: []byte("export { left as first } from './support'; export { right as second } from './support';")})
	if err != nil {
		t.Fatalf("extract barrel facts: %v", err)
	}
	main, err := Extract(extractor.Source{ProjectID: "project:fixture", SourcePath: "src/main.js", Contents: []byte("import { first, second } from './index'; export function main() { first(); second(); }")})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{main}, "project:fixture", pageResolverIndex{targets: map[string]extractor.ResolverTarget{
		"src/index.js":   pageResolverTarget(barrel),
		"src/support.js": pageResolverTarget(support),
	}})
	if err != nil {
		t.Fatalf("resolve JavaScript re-export page: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	mainFunctionID := main.Facts().Nodes[2].ID
	for _, surface := range support.ExportedSurfaces() {
		if !hasPageResolvedEdge(resolution.Facts().Edges, mainFileID, surface.NodeID, ImportsFromRelation) {
			t.Errorf("resolved facts = %+v, want re-export import edge from %q to %q", resolution.Facts(), mainFileID, surface.NodeID)
		}
		if !hasPageResolvedEdge(resolution.Facts().Edges, mainFunctionID, surface.NodeID, CallsRelation) {
			t.Errorf("resolved facts = %+v, want re-export call edge from %q to %q", resolution.Facts(), mainFunctionID, surface.NodeID)
		}
	}
}

func TestResolvePageReportsMissingNamedExport(t *testing.T) {
	support, err := Extract(extractor.Source{ProjectID: "project:fixture", SourcePath: "src/support.js", Contents: []byte("export const helper = 1;")})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	main, err := Extract(extractor.Source{ProjectID: "project:fixture", SourcePath: "src/main.js", Contents: []byte("import { missing } from './support';")})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{main}, "project:fixture", pageResolverIndex{targets: map[string]extractor.ResolverTarget{
		"src/support.js": pageResolverTarget(support),
	}})
	if err != nil {
		t.Fatalf("resolve JavaScript page: %v", err)
	}

	for _, diagnostic := range resolution.Diagnostics() {
		if diagnostic.Message == "JavaScript export \"missing\" from \"./support\" is not indexed" {
			return
		}
	}
	t.Errorf("diagnostics = %+v, want missing export diagnostic", resolution.Diagnostics())
}

func TestResolvePageKeepsCommonJSRequireResolution(t *testing.T) {
	support, err := Extract(extractor.Source{ProjectID: "project:fixture", SourcePath: "src/support.js", Contents: []byte("module.exports = { helper: 1 };")})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	main, err := Extract(extractor.Source{ProjectID: "project:fixture", SourcePath: "src/main.cjs", Contents: []byte("const support = require('./support');")})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{main}, "project:fixture", pageResolverIndex{targets: map[string]extractor.ResolverTarget{
		"src/support.js": pageResolverTarget(support),
	}})
	if err != nil {
		t.Fatalf("resolve JavaScript CommonJS page: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	supportFileID := support.Facts().Nodes[1].ID
	if !hasPageResolvedEdge(resolution.Facts().Edges, mainFileID, supportFileID, ImportsFromRelation) {
		t.Errorf("resolved facts = %+v, want CommonJS require edge from %q to %q", resolution.Facts(), mainFileID, supportFileID)
	}
}

func TestResolvePageUsesResolverIndexForCrossPageCall(t *testing.T) {
	helper, err := Extract(extractor.Source{ProjectID: "project:fixture", SourcePath: "src/helper.js", Contents: []byte("export function helper() {}")})
	if err != nil {
		t.Fatalf("extract helper facts: %v", err)
	}
	main, err := Extract(extractor.Source{ProjectID: "project:fixture", SourcePath: "src/main.js", Contents: []byte("import { helper } from './helper'; export function main() { helper(); }")})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}
	reads := 0
	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{main}, "project:fixture", pageResolverIndex{
		targets:     map[string]extractor.ResolverTarget{"src/helper.js": pageResolverTarget(helper)},
		targetReads: &reads,
	})
	if err != nil {
		t.Fatalf("resolve JavaScript page: %v", err)
	}
	mainFunctionID := main.Facts().Nodes[2].ID
	helperFunctionID := helper.Facts().Nodes[2].ID
	if !hasPageResolvedEdge(resolution.Facts().Edges, mainFunctionID, helperFunctionID, CallsRelation) {
		t.Errorf("resolved facts = %+v, want page call edge from %q to %q", resolution.Facts(), mainFunctionID, helperFunctionID)
	}
	if reads != 2 {
		t.Errorf("resolver target reads = %d, want one failed extensionless candidate and one successful target read", reads)
	}
}

type pageResolverIndex struct {
	targets        map[string]extractor.ResolverTarget
	packageTargets map[string][]extractor.ResolverTarget
	targetReads    *int
}

func (index pageResolverIndex) ResolverTarget(_ context.Context, request extractor.ResolverTargetRequest) (extractor.ResolverTarget, bool, error) {
	if index.targetReads != nil {
		*index.targetReads++
	}
	target, found := index.targets[request.SourcePath]
	return target, found, nil
}

func (index pageResolverIndex) ResolverPackagePage(_ context.Context, request extractor.ResolverPackagePageRequest) ([]extractor.ResolverTarget, error) {
	return append([]extractor.ResolverTarget(nil), index.packageTargets[request.PackagePath]...), nil
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
	}
}

func hasPageResolvedEdge(edges []graph.Edge, sourceID, targetID string, relation graph.RelationKind) bool {
	for _, edge := range edges {
		if edge.SourceID == sourceID && edge.TargetID == targetID && edge.Relation == relation {
			return true
		}
	}
	return false
}

func TestResolveAddsCrossFileExtendsRelation(t *testing.T) {
	base, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/base.js",
		Contents:   []byte("export class Base {}"),
	})
	if err != nil {
		t.Fatalf("extract base facts: %v", err)
	}
	child, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/child.js",
		Contents:   []byte("import { Base } from './base';\nexport class Child extends Base {}"),
	})
	if err != nil {
		t.Fatalf("extract child facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{child, base})
	if err != nil {
		t.Fatalf("resolve JavaScript inheritance: %v", err)
	}

	childID := child.Facts().Nodes[2].ID
	baseID := base.Facts().Nodes[2].ID
	if !hasRelation(resolution.Facts().Edges, childID, baseID, "javascript:extends") {
		t.Errorf("resolved facts = %+v, want extends edge from %q to %q", resolution.Facts(), childID, baseID)
	}
}

func TestResolveAddsCrossFileCallRelation(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/helper.js",
		Contents:   []byte("export function helper() {}"),
	})
	if err != nil {
		t.Fatalf("extract helper facts: %v", err)
	}
	caller, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/caller.js",
		Contents:   []byte("import { helper } from './helper';\nexport function run() { helper(); }"),
	})
	if err != nil {
		t.Fatalf("extract caller facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{caller, helper})
	if err != nil {
		t.Fatalf("resolve JavaScript calls: %v", err)
	}

	runID := caller.Facts().Nodes[2].ID
	helperID := helper.Facts().Nodes[2].ID
	if !hasRelation(resolution.Facts().Edges, runID, helperID, "javascript:calls") {
		t.Errorf("resolved facts = %+v, want calls edge from %q to %q", resolution.Facts(), runID, helperID)
	}
}

func TestResolveAddsCrossFileCallRelationForDefaultImport(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/helper.js",
		Contents:   []byte("export default function helper() {}"),
	})
	if err != nil {
		t.Fatalf("extract helper facts: %v", err)
	}
	caller, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/caller.js",
		Contents:   []byte("import primary from './helper';\nexport function run() { primary(); }"),
	})
	if err != nil {
		t.Fatalf("extract caller facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{caller, helper})
	if err != nil {
		t.Fatalf("resolve JavaScript default-import calls: %v", err)
	}

	runID := caller.Facts().Nodes[2].ID
	helperID := helper.Facts().Nodes[2].ID
	if !hasRelation(resolution.Facts().Edges, runID, helperID, CallsRelation) {
		t.Errorf("resolved facts = %+v, want default-import calls edge from %q to %q", resolution.Facts(), runID, helperID)
	}
}

func TestResolveAddsMethodCallRelationForImportedCallableVariable(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/helper.js",
		Contents:   []byte("export const helper = () => {};"),
	})
	if err != nil {
		t.Fatalf("extract helper facts: %v", err)
	}
	caller, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/caller.js",
		Contents: []byte("import { helper } from './helper';\n" +
			"class Service { run() { helper(); } }"),
	})
	if err != nil {
		t.Fatalf("extract caller facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{caller, helper})
	if err != nil {
		t.Fatalf("resolve JavaScript callable variable call: %v", err)
	}

	methodID := caller.Facts().Nodes[3].ID
	helperID := helper.Facts().Nodes[2].ID
	if !hasRelation(resolution.Facts().Edges, methodID, helperID, CallsRelation) {
		t.Errorf("resolved facts = %+v, want calls edge from %q to %q", resolution.Facts(), methodID, helperID)
	}
}

func TestResolveAddsFunctionCallRelationForImportedCallableVariable(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/helper.js",
		Contents:   []byte("export const helper = () => {};"),
	})
	if err != nil {
		t.Fatalf("extract helper facts: %v", err)
	}
	caller, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/caller.js",
		Contents:   []byte("import { helper } from './helper';\nexport function run() { helper(); }"),
	})
	if err != nil {
		t.Fatalf("extract caller facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{caller, helper})
	if err != nil {
		t.Fatalf("resolve JavaScript callable variable call: %v", err)
	}

	functionID := caller.Facts().Nodes[2].ID
	helperID := helper.Facts().Nodes[2].ID
	if !hasRelation(resolution.Facts().Edges, functionID, helperID, CallsRelation) {
		t.Errorf("resolved facts = %+v, want calls edge from %q to %q", resolution.Facts(), functionID, helperID)
	}
}

func TestResolveAddsNamedImportRelationToExportedDeclaration(t *testing.T) {
	support, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.js",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.js",
		Contents:   []byte("import { helper } from './support';"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{main, support})
	if err != nil {
		t.Fatalf("resolve JavaScript imports: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	helperID := support.Facts().Nodes[2].ID
	for _, edge := range resolution.Facts().Edges {
		if edge.SourceID == mainFileID && edge.TargetID == helperID && edge.Relation == "javascript:imports_from" {
			return
		}
	}
	t.Errorf("resolved facts = %+v, want import edge from %q to %q", resolution.Facts(), mainFileID, helperID)
}

func TestResolveExpandsAliasedDefaultNamespaceAndStarBindings(t *testing.T) {
	support, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.js",
		Contents: []byte("export const named = 1;\n" +
			"const internal = 2;\n" +
			"export { internal as renamed };\n" +
			"export default function fallback() {}"),
	})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.js",
		Contents: []byte("import { named as localNamed, renamed as localRenamed } from './support';\n" +
			"import fallback from './support';\n" +
			"import * as support from './support';\n" +
			"export * from './support';"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{main, support})
	if err != nil {
		t.Fatalf("resolve JavaScript module bindings: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	for _, name := range []string{"named", "renamed", "default"} {
		targetID := exportedSurfaceID(t, support, name)
		if !hasRelation(resolution.Facts().Edges, mainFileID, targetID, "javascript:imports_from") {
			t.Errorf("resolved facts = %+v, want import edge from %q to %q for %q", resolution.Facts(), mainFileID, targetID, name)
		}
		if name != "default" && !hasRelation(resolution.Facts().Edges, mainFileID, targetID, "javascript:re_exports") {
			t.Errorf("resolved facts = %+v, want re-export edge from %q to %q for %q", resolution.Facts(), mainFileID, targetID, name)
		}
		if name == "default" && hasRelation(resolution.Facts().Edges, mainFileID, targetID, "javascript:re_exports") {
			t.Errorf("resolved facts = %+v, do not want default star re-export edge from %q to %q", resolution.Facts(), mainFileID, targetID)
		}
	}
}

func TestResolveReportsMissingNamedExport(t *testing.T) {
	support, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.js",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.js",
		Contents:   []byte("import { missing } from './support';"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{main, support})
	if err != nil {
		t.Fatalf("resolve JavaScript imports: %v", err)
	}

	for _, diagnostic := range resolution.Diagnostics() {
		if diagnostic.Message == "JavaScript export \"missing\" from \"./support\" is not indexed" {
			return
		}
	}
	t.Errorf("diagnostics = %+v, want missing export diagnostic", resolution.Diagnostics())
}

func TestResolveAddsStaticReExportRelation(t *testing.T) {
	support, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.js",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	barrel, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/index.js",
		Contents:   []byte("export { helper } from './support';"),
	})
	if err != nil {
		t.Fatalf("extract barrel facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{barrel, support})
	if err != nil {
		t.Fatalf("resolve JavaScript re-exports: %v", err)
	}

	barrelFileID := barrel.Facts().Nodes[1].ID
	supportFileID := support.Facts().Nodes[1].ID
	for _, edge := range resolution.Facts().Edges {
		if edge.SourceID == barrelFileID && edge.TargetID == supportFileID && edge.Relation == "javascript:re_exports" {
			return
		}
	}
	t.Errorf("resolved facts = %+v, want re-export edge from %q to %q", resolution.Facts(), barrelFileID, supportFileID)
}

func TestResolveAddsNamedReExportRelationToExportedDeclaration(t *testing.T) {
	support, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.js",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	barrel, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/index.js",
		Contents:   []byte("export { helper as renamed } from './support';"),
	})
	if err != nil {
		t.Fatalf("extract barrel facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{barrel, support})
	if err != nil {
		t.Fatalf("resolve JavaScript re-exports: %v", err)
	}

	barrelFileID := barrel.Facts().Nodes[1].ID
	helperID := exportedSurfaceID(t, support, "helper")
	if !hasRelation(resolution.Facts().Edges, barrelFileID, helperID, "javascript:re_exports") {
		t.Errorf("resolved facts = %+v, want re-export edge from %q to %q", resolution.Facts(), barrelFileID, helperID)
	}
}

func TestResolveFollowsAliasedReExportSurface(t *testing.T) {
	support, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.js",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	barrel, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/index.js",
		Contents:   []byte("export { helper as renamed } from './support';"),
	})
	if err != nil {
		t.Fatalf("extract barrel facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.js",
		Contents:   []byte("import { renamed } from './index';"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{main, barrel, support})
	if err != nil {
		t.Fatalf("resolve JavaScript re-export chain: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	helperID := exportedSurfaceID(t, support, "helper")
	if !hasRelation(resolution.Facts().Edges, mainFileID, helperID, "javascript:imports_from") {
		t.Errorf("resolved facts = %+v, want import edge from %q to %q", resolution.Facts(), mainFileID, helperID)
	}
}

func exportedSurfaceID(t *testing.T, contribution extractor.Contribution, name string) string {
	t.Helper()
	for _, surface := range contribution.ExportedSurfaces() {
		if surface.Name == name {
			return surface.NodeID
		}
	}
	t.Fatalf("exported surfaces = %+v, want %q", contribution.ExportedSurfaces(), name)
	return ""
}

func hasRelation(edges []graph.Edge, sourceID, targetID string, relation graph.RelationKind) bool {
	for _, edge := range edges {
		if edge.SourceID == sourceID && edge.TargetID == targetID && edge.Relation == relation {
			return true
		}
	}
	return false
}

func hasRelationWithConfidence(edges []graph.Edge, sourceID, targetID string, relation graph.RelationKind, confidence graph.Confidence) bool {
	for _, edge := range edges {
		if edge.SourceID == sourceID && edge.TargetID == targetID && edge.Relation == relation && edge.Evidence.Confidence == confidence {
			return true
		}
	}
	return false
}

func TestExtractProducesClassMethodAndVariableFacts(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/service.js",
		Contents: []byte("class Service {\n" +
			"  run() { return helper; }\n" +
			"}\n" +
			"const helper = 1;\n"),
	})
	if err != nil {
		t.Fatalf("extract JavaScript facts: %v", err)
	}

	facts := contribution.Facts()
	if len(facts.Nodes) != 5 {
		t.Fatalf("node count = %d, want 5", len(facts.Nodes))
	}
	if len(facts.Edges) != 5 {
		t.Fatalf("edge count = %d, want 5", len(facts.Edges))
	}

	class := facts.Nodes[2]
	method := facts.Nodes[3]
	variable := facts.Nodes[4]
	if class.Kind != ClassNodeKind || method.Kind != MethodNodeKind || variable.Kind != VariableNodeKind {
		t.Errorf("declaration kinds = %q, %q, %q", class.Kind, method.Kind, variable.Kind)
	}
	if got := facts.Edges[2]; got.SourceID != class.ID || got.TargetID != method.ID || got.Relation != "defines" {
		t.Errorf("method definition edge = %+v, want %q -> %q", got, class.ID, method.ID)
	}
	if got := facts.Edges[4]; got.SourceID != method.ID || got.TargetID != variable.ID || got.Relation != "references" {
		t.Errorf("method reference edge = %+v, want %q -> %q", got, method.ID, variable.ID)
	}
}

func TestExtractMatchesFocusedLocalFactFixture(t *testing.T) {
	contents := []byte(strings.TrimSpace(string(testkit.ReadFixture(t, "testdata/local_facts.js"))))
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/service.js",
		Contents:   contents,
	})
	if err != nil {
		t.Fatalf("extract JavaScript fixture: %v", err)
	}

	fileSpan := graph.SourceSpan{Path: "src/service.js", StartLine: 1, StartColumn: 1, EndLine: 6, EndColumn: 18}
	classSpan := graph.SourceSpan{Path: "src/service.js", StartLine: 1, StartColumn: 1, EndLine: 5, EndColumn: 2}
	methodSpan := graph.SourceSpan{Path: "src/service.js", StartLine: 2, StartColumn: 3, EndLine: 4, EndColumn: 4}
	variableSpan := graph.SourceSpan{Path: "src/service.js", StartLine: 6, StartColumn: 7, EndLine: 6, EndColumn: 17}
	referenceSpan := graph.SourceSpan{Path: "src/service.js", StartLine: 3, StartColumn: 12, EndLine: 3, EndColumn: 18}
	hash := sha256.Sum256(contents)

	evidence := func(span graph.SourceSpan) graph.FactEvidence {
		return graph.FactEvidence{
			Span:       span,
			FileHash:   "sha256:" + hex.EncodeToString(hash[:]),
			Extractor:  "javascript@v0",
			Provenance: "static",
			Confidence: graph.ConfidenceExtracted,
		}
	}
	fileID := graph.NewNodeID("file", fileSpan)
	classID := graph.NewNodeID(ClassNodeKind, classSpan)
	methodID := graph.NewNodeID(MethodNodeKind, methodSpan)
	variableID := graph.NewNodeID(VariableNodeKind, variableSpan)
	want := graph.Facts{
		Nodes: []graph.Node{
			{ID: "project:fixture", Kind: "project", Label: "project:fixture", QualifiedName: "project:fixture", Evidence: evidence(fileSpan)},
			{ID: fileID, Kind: "file", Label: "src/service.js", QualifiedName: "src/service.js", Evidence: evidence(fileSpan)},
			{ID: classID, Kind: ClassNodeKind, Label: "Service", QualifiedName: "src/service.js::Service", Evidence: evidence(classSpan)},
			{ID: methodID, Kind: MethodNodeKind, Label: "run", QualifiedName: "src/service.js::Service.run", Evidence: evidence(methodSpan)},
			{ID: variableID, Kind: VariableNodeKind, Label: "helper", QualifiedName: "src/service.js::helper", Evidence: evidence(variableSpan)},
		},
		Edges: []graph.Edge{
			{SourceID: "project:fixture", TargetID: fileID, Relation: "contains", Evidence: evidence(fileSpan)},
			{SourceID: fileID, TargetID: classID, Relation: "defines", Evidence: evidence(classSpan)},
			{SourceID: classID, TargetID: methodID, Relation: "defines", Evidence: evidence(methodSpan)},
			{SourceID: fileID, TargetID: variableID, Relation: "defines", Evidence: evidence(variableSpan)},
			{SourceID: methodID, TargetID: variableID, Relation: "references", Evidence: evidence(referenceSpan)},
		},
	}
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshal expected JavaScript fixture facts: %v", err)
	}
	gotJSON, err := json.Marshal(contribution.Facts())
	if err != nil {
		t.Fatalf("marshal extracted JavaScript fixture facts: %v", err)
	}
	if err := testkit.CompareJSON(wantJSON, gotJSON); err != nil {
		t.Fatalf("compare JavaScript fixture facts: %v", err)
	}
	if diagnostics := contribution.Diagnostics(); len(diagnostics) != 0 {
		t.Errorf("fixture diagnostics = %+v, want none", diagnostics)
	}
}
