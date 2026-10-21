package typescript

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
	"agent-wayfinder/testkit"

	sitter "github.com/tree-sitter/go-tree-sitter"
)

func TestLanguageParsesTypeScript(t *testing.T) {
	testLanguageParsesSource(t, Language(), "export const count: number = 1;")
}

func TestTSXLanguageParsesTSX(t *testing.T) {
	testLanguageParsesSource(t, TSXLanguage(), "export const component = <section />;")
}

func TestWorkerExtractsTypeScriptAndTSXWithoutChangingFacts(t *testing.T) {
	worker, err := NewWorker()
	if err != nil {
		t.Fatalf("create TypeScript worker: %v", err)
	}
	t.Cleanup(func() {
		if err := worker.Close(); err != nil {
			t.Errorf("close TypeScript worker: %v", err)
		}
	})

	for _, source := range []extractor.Source{
		{ProjectID: "project:fixture", SourcePath: "src/service.ts", Contents: []byte("export function service() { return 1; }")},
		{ProjectID: "project:fixture", SourcePath: "src/component.tsx", Contents: []byte("export const component = <section />;")},
		{ProjectID: "project:fixture", SourcePath: "src/second.ts", Contents: []byte("export function second() { return 2; }")},
	} {
		expected, err := Extract(source)
		if err != nil {
			t.Fatalf("extract baseline source %q: %v", source.SourcePath, err)
		}
		actual, err := worker.Extract(source)
		if err != nil {
			t.Fatalf("extract worker source %q: %v", source.SourcePath, err)
		}
		if !reflect.DeepEqual(actual.Facts(), expected.Facts()) {
			t.Errorf("worker facts for %q differ from Extract", source.SourcePath)
		}
		if !reflect.DeepEqual(actual.UnresolvedReferences(), expected.UnresolvedReferences()) || !reflect.DeepEqual(actual.SymbolReferences(), expected.SymbolReferences()) || !reflect.DeepEqual(actual.ExportedSurfaces(), expected.ExportedSurfaces()) || !reflect.DeepEqual(actual.Diagnostics(), expected.Diagnostics()) {
			t.Errorf("worker metadata for %q differs from Extract", source.SourcePath)
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
				SourcePath: fmt.Sprintf("src/worker-%d.ts", index),
				Contents:   []byte("export function worker() { return 1; }"),
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

func TestExtractProducesFunctionFactsWithEvidence(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/greet.ts",
		Contents:   []byte("function greet(name: string) { return name; }"),
	})
	if err != nil {
		t.Fatalf("extract TypeScript facts: %v", err)
	}

	facts := contribution.Facts()
	if len(facts.Nodes) != 3 {
		t.Fatalf("node count = %d, want 3", len(facts.Nodes))
	}
	if len(facts.Edges) != 2 {
		t.Fatalf("edge count = %d, want 2", len(facts.Edges))
	}

	fileSpan := graph.SourceSpan{Path: "src/greet.ts", StartLine: 1, StartColumn: 1, EndLine: 1, EndColumn: 46}
	functionSpan := fileSpan
	wantFileID := graph.NewNodeID("file", fileSpan)
	wantFunctionID := graph.NewNodeID(FunctionNodeKind, functionSpan)
	wantEvidence := graph.FactEvidence{
		Span:       fileSpan,
		FileHash:   "sha256:d8e716f2e2e3f20e7b273f9cd02f8fe514958562ae436530fa75778eeaf01a2a",
		Extractor:  "typescript@v0",
		Provenance: "static",
		Confidence: graph.ConfidenceExtracted,
	}

	if got := facts.Nodes[0]; got.ID != "project:fixture" || got.Kind != "project" || got.Label != "project:fixture" || got.QualifiedName != "project:fixture" {
		t.Errorf("project node = %+v, want project query names", got)
	}
	if got := facts.Nodes[1]; got.ID != wantFileID || got.Kind != "file" || got.Label != "src/greet.ts" || got.QualifiedName != "src/greet.ts" || got.Evidence != wantEvidence {
		t.Errorf("file node = %+v, want ID %q with query names and evidence %+v", got, wantFileID, wantEvidence)
	}
	if got := facts.Nodes[2]; got.ID != wantFunctionID || got.Kind != FunctionNodeKind || got.Label != "greet" || got.QualifiedName != "src/greet.ts::greet" || got.Evidence != wantEvidence {
		t.Errorf("function node = %+v, want ID %q with query names and evidence %+v", got, wantFunctionID, wantEvidence)
	}
	if got := facts.Edges[0]; got.SourceID != "project:fixture" || got.TargetID != wantFileID || got.Relation != "contains" || got.Evidence != wantEvidence {
		t.Errorf("containment edge = %+v", got)
	}
	if got := facts.Edges[1]; got.SourceID != wantFileID || got.TargetID != wantFunctionID || got.Relation != "defines" || got.Evidence != wantEvidence {
		t.Errorf("definition edge = %+v", got)
	}
}

func TestExtractQualifiesNestedDeclarations(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/service.ts",
		Contents:   []byte("class Service { run() {} }"),
	})
	if err != nil {
		t.Fatalf("extract TypeScript facts: %v", err)
	}

	qualifiedNames := make(map[string]string)
	for _, node := range contribution.Facts().Nodes {
		qualifiedNames[node.Label] = node.QualifiedName
	}
	if got := qualifiedNames["Service"]; got != "src/service.ts::Service" {
		t.Errorf("Service qualified name = %q, want src/service.ts::Service", got)
	}
	if got := qualifiedNames["run"]; got != "src/service.ts::Service.run" {
		t.Errorf("run qualified name = %q, want src/service.ts::Service.run", got)
	}
}

func TestExtractProvidesStaticImportForResolution(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("import { helper } from './support';\nexport const value = helper;"),
	})
	if err != nil {
		t.Fatalf("extract TypeScript facts: %v", err)
	}

	references := contribution.UnresolvedReferences()
	if len(references) != 1 {
		t.Fatalf("unresolved reference count = %d, want 1", len(references))
	}
	if got := references[0].Target; got != "./support" {
		t.Errorf("import target = %q, want %q", got, "./support")
	}
}

func TestExtractProvidesConstantDynamicImportForResolution(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("const support = import('./support');"),
	})
	if err != nil {
		t.Fatalf("extract TypeScript facts: %v", err)
	}

	references := contribution.UnresolvedReferences()
	if len(references) != 1 {
		t.Fatalf("unresolved reference count = %d, want 1", len(references))
	}
	if got := references[0].Target; got != "./support" {
		t.Errorf("dynamic import target = %q, want %q", got, "./support")
	}
}

func TestExtractAcceptsTypeQueryInCallTypeArguments(t *testing.T) {
	_, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/filter-controller.spec.ts",
		Contents:   []byte("const actual = await importOriginal<typeof import('./convert-url.ts')>();"),
	})
	if err != nil {
		t.Fatalf("extract valid TypeScript type-query call: %v", err)
	}
}

func TestExtractAcceptsTypeQueryOutsideCallTypeArguments(t *testing.T) {
	_, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/module.ts",
		Contents:   []byte("const module: typeof import('./module.ts') = {} as typeof import('./module.ts');"),
	})
	if err != nil {
		t.Fatalf("extract valid TypeScript type query: %v", err)
	}
}

func TestExtractAcceptsMultipleTypeQueryCallArguments(t *testing.T) {
	_, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/type-queries.ts",
		Contents:   []byte("const first = load<typeof import('./first.ts')>(); const second = load<typeof import('./second.ts')>();"),
	})
	if err != nil {
		t.Fatalf("extract multiple valid TypeScript type-query calls: %v", err)
	}
}

func TestExtractReportsActionableParseError(t *testing.T) {
	_, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/broken.ts",
		Contents:   []byte("const value = ;"),
	})
	if err == nil {
		t.Fatal("extract malformed TypeScript source succeeded")
	}
	for _, want := range []string{`parse TypeScript source "src/broken.ts" at 1:13-1:14: ERROR`} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("parse error = %q, want %q", err, want)
		}
	}
}

func TestExtractIgnoresStringLiteralsInsideDeclarationExports(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("export let baseUrl = (import.meta.env.BASE_URL || '').replace(/\\/+$/, '');"),
	})
	if err != nil {
		t.Fatalf("extract TypeScript facts: %v", err)
	}
	if references := contribution.UnresolvedReferences(); len(references) != 0 {
		t.Errorf("unresolved references = %+v, want none for a declaration export with no module source", references)
	}
}

func TestExtractProvidesReExportForResolution(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("export { helper } from './support';"),
	})
	if err != nil {
		t.Fatalf("extract TypeScript facts: %v", err)
	}

	references := contribution.UnresolvedReferences()
	if len(references) != 1 {
		t.Fatalf("unresolved reference count = %d, want 1", len(references))
	}
	if got := references[0].Target; got != "./support" {
		t.Errorf("re-export target = %q, want %q", got, "./support")
	}
}

func TestExtractProvidesTypeOnlyStarReExportForResolution(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("export type * from './support.ts';"),
	})
	if err != nil {
		t.Fatalf("extract TypeScript type-only star re-export: %v", err)
	}

	references := contribution.UnresolvedReferences()
	if len(references) != 1 {
		t.Fatalf("unresolved reference count = %d, want 1", len(references))
	}
	if got := references[0].Target; got != "./support.ts" {
		t.Errorf("type-only star re-export target = %q, want %q", got, "./support.ts")
	}
}

func TestExtractReportsUnboundedDynamicImport(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("const support = import(moduleName);"),
	})
	if err != nil {
		t.Fatalf("extract TypeScript facts: %v", err)
	}

	if references := contribution.UnresolvedReferences(); len(references) != 0 {
		t.Errorf("unresolved references = %+v, want none", references)
	}
	if diagnostics := contribution.Diagnostics(); len(diagnostics) != 1 || !strings.Contains(diagnostics[0].Message, "is unbounded") {
		t.Errorf("diagnostics = %+v, want unbounded dynamic import diagnostic", diagnostics)
	}
}

func TestExtractReportsOverLimitDynamicImport(t *testing.T) {
	expression := "'./module-100'"
	for index := 99; index >= 0; index-- {
		expression = fmt.Sprintf("enabled%d ? './module-%d' : %s", index, index, expression)
	}
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("const support = import(" + expression + ");"),
	})
	if err != nil {
		t.Fatalf("extract TypeScript facts: %v", err)
	}

	if references := contribution.UnresolvedReferences(); len(references) != 0 {
		t.Errorf("unresolved references = %+v, want none", references)
	}
	if diagnostics := contribution.Diagnostics(); len(diagnostics) != 1 || !strings.Contains(diagnostics[0].Message, "exceeds the limit of 100 candidates") {
		t.Errorf("diagnostics = %+v, want over-limit dynamic import diagnostic", diagnostics)
	}
}

func TestExtractDecodesEscapedStaticImportForResolution(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("import { helper } from './support\\x2ets';\nexport const value = helper;"),
	})
	if err != nil {
		t.Fatalf("extract TypeScript facts: %v", err)
	}

	references := contribution.UnresolvedReferences()
	if len(references) != 1 {
		t.Fatalf("unresolved reference count = %d, want 1", len(references))
	}
	if got := references[0].Target; got != "./support.ts" {
		t.Errorf("import target = %q, want %q", got, "./support.ts")
	}
}

func TestExtractProvidesExportedSurfaceForNamedDeclaration(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.ts",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract TypeScript facts: %v", err)
	}

	surfaces := contribution.ExportedSurfaces()
	if len(surfaces) != 1 {
		t.Fatalf("exported surface count = %d, want 1", len(surfaces))
	}
	if surfaces[0].Name != "helper" || surfaces[0].NodeID != contribution.Facts().Nodes[2].ID {
		t.Errorf("exported surface = %+v, want helper for %q", surfaces[0], contribution.Facts().Nodes[2].ID)
	}
}

func TestExtractProvidesSurfacesForMultipleDeclarationExports(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.ts",
		Contents: []byte(`
export function first() {}
export default function second() {}
function third() {}
export { third as renamed }
export class Container { method() {} }
`),
	})
	if err != nil {
		t.Fatalf("extract TypeScript facts: %v", err)
	}

	nodeIDsByLabel := make(map[string]string)
	for _, node := range contribution.Facts().Nodes {
		nodeIDsByLabel[node.Label] = node.ID
	}
	surfaces := make(map[string]string)
	for _, surface := range contribution.ExportedSurfaces() {
		surfaces[surface.Name] = surface.NodeID
	}
	for name, label := range map[string]string{
		"first":     "first",
		"default":   "second",
		"renamed":   "third",
		"Container": "Container",
		"method":    "method",
	} {
		if surfaces[name] != nodeIDsByLabel[label] {
			t.Errorf("surface %q = %q, want node %q", name, surfaces[name], nodeIDsByLabel[label])
		}
	}
	if len(surfaces) != 5 {
		t.Errorf("exported surfaces = %+v, want five surfaces", contribution.ExportedSurfaces())
	}
}

func TestResolveAddsStaticImportRelation(t *testing.T) {
	support, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.ts",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("import { helper } from './support';\nexport const value = helper;"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{main, support})
	if err != nil {
		t.Fatalf("resolve TypeScript imports: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	supportFileID := support.Facts().Nodes[1].ID
	for _, edge := range resolution.Facts().Edges {
		if edge.SourceID == mainFileID && edge.TargetID == supportFileID && edge.Relation == "typescript:imports_from" {
			return
		}
	}
	t.Errorf("resolved facts = %+v, want import edge from %q to %q", resolution.Facts(), mainFileID, supportFileID)
}

func TestResolvePageUsesResolverIndexForCrossPageImport(t *testing.T) {
	support, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.ts",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("import { helper } from './support';\nexport const value = helper;"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{main}, "project:fixture", resolverIndex{targets: map[string]extractor.ResolverTarget{
		"src/support.ts": resolverTargetFromContribution(support),
	}})
	if err != nil {
		t.Fatalf("resolve TypeScript page: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	supportFileID := support.Facts().Nodes[1].ID
	supportSurface := support.ExportedSurfaces()[0].NodeID
	if !hasResolvedEdge(resolution.Facts().Edges, mainFileID, supportFileID, ImportsFromRelation) {
		t.Errorf("resolved facts = %+v, want page import edge from %q to %q", resolution.Facts(), mainFileID, supportFileID)
	}
	if !hasResolvedEdge(resolution.Facts().Edges, mainFileID, supportSurface, ImportsFromRelation) {
		t.Errorf("resolved facts = %+v, want page import edge from %q to exported surface %q", resolution.Facts(), mainFileID, supportSurface)
	}
}

func TestResolvePageUsesResolverIndexForCrossPageCall(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/helper.ts",
		Contents:   []byte("export function helper() {}"),
	})
	if err != nil {
		t.Fatalf("extract helper facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("import { helper } from './helper';\nexport function main() { helper(); }"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{main}, "project:fixture", resolverIndex{targets: map[string]extractor.ResolverTarget{
		"src/helper.ts": resolverTargetFromContribution(helper),
	}})
	if err != nil {
		t.Fatalf("resolve TypeScript page: %v", err)
	}
	mainFunctionID := main.Facts().Nodes[2].ID
	helperFunctionID := helper.Facts().Nodes[2].ID
	if !hasResolvedEdge(resolution.Facts().Edges, mainFunctionID, helperFunctionID, CallsRelation) {
		t.Errorf("resolved facts = %+v, want page call edge from %q to %q", resolution.Facts(), mainFunctionID, helperFunctionID)
	}
}

func TestResolvePageReadsEachImportedTargetOnce(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/helper.ts",
		Contents:   []byte("export function helper() {}"),
	})
	if err != nil {
		t.Fatalf("extract helper facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("import { helper } from './helper';\nexport function main() { helper(); helper(); }"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	reads := 0
	index := resolverIndex{targets: map[string]extractor.ResolverTarget{
		"src/helper.ts": resolverTargetFromContribution(helper),
	}, targetReads: &reads}
	if _, err := ResolvePage(context.Background(), []extractor.Contribution{main}, "project:fixture", index); err != nil {
		t.Fatalf("resolve TypeScript page: %v", err)
	}
	if reads != 2 {
		t.Errorf("resolver target reads = %d, want one failed extensionless candidate and one successful target read", reads)
	}
}

func TestResolvePageUsesResolverIndexForCrossPageReExport(t *testing.T) {
	support, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.ts",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	barrel, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/index.ts",
		Contents:   []byte("export { helper as renamed } from './support';"),
	})
	if err != nil {
		t.Fatalf("extract barrel facts: %v", err)
	}

	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{barrel}, "project:fixture", resolverIndex{targets: map[string]extractor.ResolverTarget{
		"src/support.ts": resolverTargetFromContribution(support),
	}})
	if err != nil {
		t.Fatalf("resolve TypeScript page: %v", err)
	}
	barrelFileID := barrel.Facts().Nodes[1].ID
	helperID := support.ExportedSurfaces()[0].NodeID
	if !hasResolvedEdge(resolution.Facts().Edges, barrelFileID, helperID, ReExportsRelation) {
		t.Errorf("resolved facts = %+v, want re-export edge from %q to %q", resolution.Facts(), barrelFileID, helperID)
	}
}

type resolverIndex struct {
	targets        map[string]extractor.ResolverTarget
	packageTargets map[string][]extractor.ResolverTarget
	targetReads    *int
}

func (index resolverIndex) ResolverTarget(_ context.Context, request extractor.ResolverTargetRequest) (extractor.ResolverTarget, bool, error) {
	if index.targetReads != nil {
		*index.targetReads++
	}
	target, found := index.targets[request.SourcePath]
	return target, found, nil
}

func (index resolverIndex) ResolverPackagePage(_ context.Context, request extractor.ResolverPackagePageRequest) ([]extractor.ResolverTarget, error) {
	return append([]extractor.ResolverTarget(nil), index.packageTargets[request.PackagePath]...), nil
}

func resolverTargetFromContribution(contribution extractor.Contribution) extractor.ResolverTarget {
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

func resolverTargetFromProject(contribution extractor.Contribution, projectID string) extractor.ResolverTarget {
	target := resolverTargetFromContribution(contribution)
	target.ProjectID = projectID
	return target
}

func TestResolvePageUsesWorkspacePackageReexportsForCrossProjectImplementations(t *testing.T) {
	contract, err := Extract(extractor.Source{
		ProjectID:  "project:packages/core",
		SourcePath: "packages/core/src/features/storage-driver/storage-driver.ts",
		Contents:   []byte("export interface StorageDriver {}"),
	})
	if err != nil {
		t.Fatalf("extract contract: %v", err)
	}
	entry, err := Extract(extractor.Source{
		ProjectID:  "project:packages/core",
		SourcePath: "packages/core/src/index.ts",
		Contents:   []byte("export * from './features/storage-driver/storage-driver.js';"),
	})
	if err != nil {
		t.Fatalf("extract package entry: %v", err)
	}
	implementation, err := Extract(extractor.Source{
		ProjectID:  "project:packages/api-pg",
		SourcePath: "packages/api-pg/src/pg-store.ts",
		Contents:   []byte("import { StorageDriver } from '@agent-issues/core';\nexport class PgStore implements StorageDriver {}"),
	})
	if err != nil {
		t.Fatalf("extract implementation: %v", err)
	}

	index := resolverIndex{
		targets: map[string]extractor.ResolverTarget{
			entry.SourcePath():    resolverTargetFromProject(entry, "project:packages/core"),
			contract.SourcePath(): resolverTargetFromProject(contract, "project:packages/core"),
		},
		packageTargets: map[string][]extractor.ResolverTarget{
			"packages/core/src": {resolverTargetFromProject(entry, "project:packages/core")},
		},
	}
	packageTarget, _, packageErr := resolverPageTarget(context.Background(), implementation.SourcePath(), "@agent-issues/core", implementation.Metadata().Name, index)
	if packageErr != nil {
		t.Fatalf("resolve package target: %v", packageErr)
	}
	_, surfaceErr := resolverPageExportedSurfaces(context.Background(), packageTarget, index, make(map[string]struct{}), make(map[string]graph.Node))
	if surfaceErr != nil {
		t.Fatalf("resolve package surfaces: %v", surfaceErr)
	}
	resolution, err := ResolvePage(context.Background(), []extractor.Contribution{implementation}, "project:packages/api-pg", index)
	if err != nil {
		t.Fatalf("resolve cross-project implementation: %v", err)
	}
	implementationID := implementation.ExportedSurfaces()[0].NodeID
	contractID := contract.ExportedSurfaces()[0].NodeID
	if !hasResolvedEdge(resolution.Facts().Edges, implementationID, contractID, ImplementsRelation) {
		t.Errorf("resolved facts = %+v, want cross-project StorageDriver implementation", resolution.Facts())
	}
}

func hasResolvedEdge(edges []graph.Edge, sourceID, targetID string, relation graph.RelationKind) bool {
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
		SourcePath: "src/base.ts",
		Contents:   []byte("export class Base {}"),
	})
	if err != nil {
		t.Fatalf("extract base facts: %v", err)
	}
	child, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/child.ts",
		Contents:   []byte("import { Base } from './base';\nexport class Child extends Base {}"),
	})
	if err != nil {
		t.Fatalf("extract child facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{child, base})
	if err != nil {
		t.Fatalf("resolve TypeScript inheritance: %v", err)
	}

	childID := child.Facts().Nodes[2].ID
	baseID := base.Facts().Nodes[2].ID
	edge, found := findRelation(resolution.Facts().Edges, childID, baseID, ExtendsRelation)
	if !found {
		t.Errorf("resolved facts = %+v, want extends edge from %q to %q", resolution.Facts(), childID, baseID)
		return
	}
	wantEvidence := child.Facts().Nodes[1].Evidence
	wantEvidence.Span = graph.SourceSpan{Path: "src/child.ts", StartLine: 2, StartColumn: 28, EndLine: 2, EndColumn: 32}
	if edge.Evidence != wantEvidence {
		t.Errorf("extends evidence = %+v, want %+v", edge.Evidence, wantEvidence)
	}
}

func TestResolveAddsCrossFileExtendsRelationForAliasedImport(t *testing.T) {
	base, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/base.ts",
		Contents:   []byte("export class Base {}"),
	})
	if err != nil {
		t.Fatalf("extract base facts: %v", err)
	}
	child, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/child.ts",
		Contents:   []byte("import { Base as Parent } from './base';\nexport class Child extends Parent {}"),
	})
	if err != nil {
		t.Fatalf("extract child facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{child, base})
	if err != nil {
		t.Fatalf("resolve TypeScript inheritance: %v", err)
	}

	childID := child.Facts().Nodes[2].ID
	baseID := base.Facts().Nodes[2].ID
	if !hasRelation(resolution.Facts().Edges, childID, baseID, ExtendsRelation) {
		t.Errorf("resolved facts = %+v, want aliased extends edge from %q to %q", resolution.Facts(), childID, baseID)
	}
}

func TestResolveAddsCrossFileClassToInterfaceExtendsRelation(t *testing.T) {
	base, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/base.ts",
		Contents:   []byte("export interface Base {}"),
	})
	if err != nil {
		t.Fatalf("extract interface facts: %v", err)
	}
	child, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/child.ts",
		Contents:   []byte("import { Base } from './base';\nexport class Child extends Base {}"),
	})
	if err != nil {
		t.Fatalf("extract class facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{child, base})
	if err != nil {
		t.Fatalf("resolve TypeScript class-to-interface inheritance: %v", err)
	}

	childID := child.Facts().Nodes[2].ID
	baseID := base.Facts().Nodes[2].ID
	if !hasRelation(resolution.Facts().Edges, childID, baseID, ExtendsRelation) {
		t.Errorf("resolved facts = %+v, want extends edge from class %q to interface %q", resolution.Facts(), childID, baseID)
	}
}

func TestResolveAddsCrossFileClassToVariableExtendsRelation(t *testing.T) {
	base, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/base.ts",
		Contents:   []byte("class Base {}\nexport const BaseElement = Base as typeof Base;"),
	})
	if err != nil {
		t.Fatalf("extract constructable variable facts: %v", err)
	}
	child, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/child.ts",
		Contents:   []byte("import { BaseElement } from './base';\nexport class Child extends BaseElement {}"),
	})
	if err != nil {
		t.Fatalf("extract child facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{child, base})
	if err != nil {
		t.Fatalf("resolve TypeScript class-to-variable inheritance: %v", err)
	}

	childID := child.Facts().Nodes[2].ID
	baseElementID := base.Facts().Nodes[3].ID
	if !hasRelation(resolution.Facts().Edges, childID, baseElementID, ExtendsRelation) {
		t.Errorf("resolved facts = %+v, want extends edge from class %q to variable %q", resolution.Facts(), childID, baseElementID)
	}
}

func TestResolveAddsCrossFileImplementsRelation(t *testing.T) {
	contract, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/writer.ts",
		Contents:   []byte("export interface Writer {}"),
	})
	if err != nil {
		t.Fatalf("extract interface facts: %v", err)
	}
	implementation, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/console-writer.ts",
		Contents:   []byte("import { Writer } from './writer';\nexport class ConsoleWriter implements Writer {}"),
	})
	if err != nil {
		t.Fatalf("extract implementation facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{implementation, contract})
	if err != nil {
		t.Fatalf("resolve TypeScript implementation: %v", err)
	}

	implementationID := implementation.Facts().Nodes[2].ID
	contractID := contract.Facts().Nodes[2].ID
	if !hasRelation(resolution.Facts().Edges, implementationID, contractID, ImplementsRelation) {
		t.Errorf("resolved facts = %+v, want implements edge from %q to %q", resolution.Facts(), implementationID, contractID)
	}
}

func TestResolveAddsCrossFileInterfaceExtendsRelation(t *testing.T) {
	parent, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/parent.ts",
		Contents:   []byte("export interface Parent {}"),
	})
	if err != nil {
		t.Fatalf("extract parent interface facts: %v", err)
	}
	child, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/child.ts",
		Contents:   []byte("import { Parent } from './parent';\nexport interface Child extends Parent {}"),
	})
	if err != nil {
		t.Fatalf("extract child interface facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{child, parent})
	if err != nil {
		t.Fatalf("resolve TypeScript interface inheritance: %v", err)
	}

	childID := child.Facts().Nodes[2].ID
	parentID := parent.Facts().Nodes[2].ID
	if !hasRelation(resolution.Facts().Edges, childID, parentID, ExtendsRelation) {
		t.Errorf("resolved facts = %+v, want interface extends edge from %q to %q", resolution.Facts(), childID, parentID)
	}
}

func TestResolveAddsCrossFileInterfaceToTypeAliasExtendsRelation(t *testing.T) {
	parent, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/parent.ts",
		Contents:   []byte("export type Parent = { id: string };"),
	})
	if err != nil {
		t.Fatalf("extract parent type alias facts: %v", err)
	}
	child, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/child.ts",
		Contents:   []byte("import { Parent } from './parent';\nexport interface Child extends Parent {}"),
	})
	if err != nil {
		t.Fatalf("extract child interface facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{child, parent})
	if err != nil {
		t.Fatalf("resolve TypeScript interface-to-type-alias inheritance: %v", err)
	}

	childID := child.Facts().Nodes[2].ID
	parentID := parent.Facts().Nodes[2].ID
	if !hasRelation(resolution.Facts().Edges, childID, parentID, ExtendsRelation) {
		t.Errorf("resolved facts = %+v, want interface extends edge from %q to type alias %q", resolution.Facts(), childID, parentID)
	}
}

func TestResolveClassExtendsIgnoresGenericTypeArguments(t *testing.T) {
	base, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/base.ts",
		Contents:   []byte("export class Base<T> {}\nexport type Argument = { id: string };"),
	})
	if err != nil {
		t.Fatalf("extract base facts: %v", err)
	}
	child, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/child.ts",
		Contents:   []byte("import { Argument, Base } from './base';\nexport class Child extends Base<Argument> {}"),
	})
	if err != nil {
		t.Fatalf("extract child facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{child, base})
	if err != nil {
		t.Fatalf("resolve TypeScript class inheritance: %v", err)
	}

	childID := child.Facts().Nodes[2].ID
	baseID := base.Facts().Nodes[2].ID
	argumentID := base.Facts().Nodes[3].ID
	if !hasRelation(resolution.Facts().Edges, childID, baseID, ExtendsRelation) {
		t.Errorf("resolved facts = %+v, want extends edge from %q to %q", resolution.Facts(), childID, baseID)
	}
	if hasRelation(resolution.Facts().Edges, childID, argumentID, ExtendsRelation) {
		t.Errorf("resolved facts = %+v, do not want extends edge from %q to generic argument %q", resolution.Facts(), childID, argumentID)
	}
}

func TestResolveAddsCrossFileCallRelation(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/helper.ts",
		Contents:   []byte("export function helper() {}"),
	})
	if err != nil {
		t.Fatalf("extract helper facts: %v", err)
	}
	caller, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/caller.ts",
		Contents:   []byte("import { helper } from './helper';\nexport function run() { helper(); }"),
	})
	if err != nil {
		t.Fatalf("extract caller facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{caller, helper})
	if err != nil {
		t.Fatalf("resolve TypeScript calls: %v", err)
	}

	runID := caller.Facts().Nodes[2].ID
	helperID := helper.Facts().Nodes[2].ID
	if !hasRelation(resolution.Facts().Edges, runID, helperID, "typescript:calls") {
		t.Errorf("resolved facts = %+v, want calls edge from %q to %q", resolution.Facts(), runID, helperID)
	}
}

func TestResolveAddsCrossFileCallRelationForDefaultImport(t *testing.T) {
	helper, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/helper.ts",
		Contents:   []byte("export default function helper() {}"),
	})
	if err != nil {
		t.Fatalf("extract helper facts: %v", err)
	}
	caller, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/caller.ts",
		Contents:   []byte("import primary from './helper';\nexport function run() { primary(); }"),
	})
	if err != nil {
		t.Fatalf("extract caller facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{caller, helper})
	if err != nil {
		t.Fatalf("resolve TypeScript default-import calls: %v", err)
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
		SourcePath: "src/helper.ts",
		Contents:   []byte("export const helper = () => {};"),
	})
	if err != nil {
		t.Fatalf("extract helper facts: %v", err)
	}
	caller, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/caller.ts",
		Contents: []byte("import { helper } from './helper';\n" +
			"class Service { run() { helper(); } }"),
	})
	if err != nil {
		t.Fatalf("extract caller facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{caller, helper})
	if err != nil {
		t.Fatalf("resolve TypeScript callable variable call: %v", err)
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
		SourcePath: "src/helper.ts",
		Contents:   []byte("export const helper = () => {};"),
	})
	if err != nil {
		t.Fatalf("extract helper facts: %v", err)
	}
	caller, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/caller.ts",
		Contents:   []byte("import { helper } from './helper';\nexport function run() { helper(); }"),
	})
	if err != nil {
		t.Fatalf("extract caller facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{caller, helper})
	if err != nil {
		t.Fatalf("resolve TypeScript callable variable call: %v", err)
	}

	functionID := caller.Facts().Nodes[2].ID
	helperID := helper.Facts().Nodes[2].ID
	if !hasRelation(resolution.Facts().Edges, functionID, helperID, CallsRelation) {
		t.Errorf("resolved facts = %+v, want calls edge from %q to %q", resolution.Facts(), functionID, helperID)
	}
}

func TestResolveMarksBoundedDynamicImportCandidatesAmbiguous(t *testing.T) {
	first, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/first.ts",
		Contents:   []byte("export const first = 1;"),
	})
	if err != nil {
		t.Fatalf("extract first facts: %v", err)
	}
	second, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/second.ts",
		Contents:   []byte("export const second = 2;"),
	})
	if err != nil {
		t.Fatalf("extract second facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("const support = import(enabled ? './first' : './second');"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{main, first, second})
	if err != nil {
		t.Fatalf("resolve TypeScript imports: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	for _, target := range []string{first.Facts().Nodes[1].ID, second.Facts().Nodes[1].ID} {
		if !hasRelationWithConfidence(resolution.Facts().Edges, mainFileID, target, ImportsFromRelation, graph.ConfidenceAmbiguous) {
			t.Errorf("resolved facts = %+v, want ambiguous import edge from %q to %q", resolution.Facts(), mainFileID, target)
		}
	}
}

func TestResolveWithFileViewAppliesNearestTypeScriptPathAlias(t *testing.T) {
	support, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/lib/support.ts",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("import { helper } from '@app/lib/support';"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"tsconfig.json": []byte(`{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/*"]}}}`),
	})
	if err != nil {
		t.Fatalf("new resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main, support}, view)
	if err != nil {
		t.Fatalf("resolve TypeScript alias: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	supportFileID := support.Facts().Nodes[1].ID
	if !hasRelation(resolution.Facts().Edges, mainFileID, supportFileID, ImportsFromRelation) {
		t.Errorf("resolved facts = %+v, want import edge from %q to %q", resolution.Facts(), mainFileID, supportFileID)
	}
}

func TestResolveWithFileViewUsesImportPackageExport(t *testing.T) {
	packageEntry, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "node_modules/example-package/esm.ts",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract package entry facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("import { helper } from 'example-package';"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"node_modules/example-package/package.json": []byte(`{"exports":{"import":"./esm.ts","default":"./fallback.ts"}}`),
	})
	if err != nil {
		t.Fatalf("new resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main, packageEntry}, view)
	if err != nil {
		t.Fatalf("resolve TypeScript package import: %v", err)
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
		SourcePath: "node_modules/example-package/sub.ts",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract package entry facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("import { helper } from 'example-package/sub';"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"node_modules/example-package/package.json": []byte(`{"main":"./main.ts"}`),
	})
	if err != nil {
		t.Fatalf("new resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main, packageEntry}, view)
	if err != nil {
		t.Fatalf("resolve TypeScript package subpath: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	packageFileID := packageEntry.Facts().Nodes[1].ID
	if !hasRelation(resolution.Facts().Edges, mainFileID, packageFileID, ImportsFromRelation) {
		t.Errorf("resolved facts = %+v, want import edge from %q to %q", resolution.Facts(), mainFileID, packageFileID)
	}
}

func TestResolveWithFileViewUsesPackageMainWithoutExports(t *testing.T) {
	packageEntry, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "node_modules/example-package/main.ts",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract package entry facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("import { helper } from 'example-package';"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"node_modules/example-package/package.json": []byte(`{"main":"./main.ts"}`),
	})
	if err != nil {
		t.Fatalf("new resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main, packageEntry}, view)
	if err != nil {
		t.Fatalf("resolve TypeScript package main: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	packageFileID := packageEntry.Facts().Nodes[1].ID
	if !hasRelation(resolution.Facts().Edges, mainFileID, packageFileID, ImportsFromRelation) {
		t.Errorf("resolved facts = %+v, want import edge from %q to %q", resolution.Facts(), mainFileID, packageFileID)
	}
}

func TestResolveWithFileViewReportsUnsupportedModuleResolution(t *testing.T) {
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("export const value = 1;"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}
	view, err := extractor.NewResolverFileView(".", map[string][]byte{
		"tsconfig.json": []byte(`{"compilerOptions":{"moduleResolution":"classic"}}`),
	})
	if err != nil {
		t.Fatalf("new resolver file view: %v", err)
	}

	resolution, err := ResolveWithFileView([]extractor.Contribution{main}, view)
	if err != nil {
		t.Fatalf("resolve TypeScript configuration: %v", err)
	}

	for _, diagnostic := range resolution.Diagnostics() {
		if diagnostic.Message == `TypeScript moduleResolution "classic" in "tsconfig.json" is unsupported` {
			return
		}
	}
	t.Errorf("diagnostics = %+v, want unsupported moduleResolution diagnostic", resolution.Diagnostics())
}

func TestResolveAddsNamedImportRelationToExportedDeclaration(t *testing.T) {
	support, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.ts",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("import { helper } from './support';"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{main, support})
	if err != nil {
		t.Fatalf("resolve TypeScript imports: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	helperID := support.Facts().Nodes[2].ID
	for _, edge := range resolution.Facts().Edges {
		if edge.SourceID == mainFileID && edge.TargetID == helperID && edge.Relation == "typescript:imports_from" {
			return
		}
	}
	t.Errorf("resolved facts = %+v, want import edge from %q to %q", resolution.Facts(), mainFileID, helperID)
}

func TestResolveExpandsAliasedDefaultNamespaceAndStarBindings(t *testing.T) {
	support, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.ts",
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
		SourcePath: "src/main.ts",
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
		t.Fatalf("resolve TypeScript module bindings: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	for _, name := range []string{"named", "renamed", "default"} {
		targetID := exportedSurfaceID(t, support, name)
		if !hasRelation(resolution.Facts().Edges, mainFileID, targetID, "typescript:imports_from") {
			t.Errorf("resolved facts = %+v, want import edge from %q to %q for %q", resolution.Facts(), mainFileID, targetID, name)
		}
		if name != "default" && !hasRelation(resolution.Facts().Edges, mainFileID, targetID, "typescript:re_exports") {
			t.Errorf("resolved facts = %+v, want re-export edge from %q to %q for %q", resolution.Facts(), mainFileID, targetID, name)
		}
		if name == "default" && hasRelation(resolution.Facts().Edges, mainFileID, targetID, "typescript:re_exports") {
			t.Errorf("resolved facts = %+v, do not want default star re-export edge from %q to %q", resolution.Facts(), mainFileID, targetID)
		}
	}
}

func TestResolveReportsMissingNamedExport(t *testing.T) {
	support, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.ts",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("import { missing } from './support';"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{main, support})
	if err != nil {
		t.Fatalf("resolve TypeScript imports: %v", err)
	}

	for _, diagnostic := range resolution.Diagnostics() {
		if diagnostic.Message == "TypeScript export \"missing\" from \"./support\" is not indexed" {
			return
		}
	}
	t.Errorf("diagnostics = %+v, want missing export diagnostic", resolution.Diagnostics())
}

func TestResolveAddsStaticReExportRelation(t *testing.T) {
	support, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.ts",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	barrel, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/index.ts",
		Contents:   []byte("export { helper } from './support';"),
	})
	if err != nil {
		t.Fatalf("extract barrel facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{barrel, support})
	if err != nil {
		t.Fatalf("resolve TypeScript re-exports: %v", err)
	}

	barrelFileID := barrel.Facts().Nodes[1].ID
	supportFileID := support.Facts().Nodes[1].ID
	for _, edge := range resolution.Facts().Edges {
		if edge.SourceID == barrelFileID && edge.TargetID == supportFileID && edge.Relation == "typescript:re_exports" {
			return
		}
	}
	t.Errorf("resolved facts = %+v, want re-export edge from %q to %q", resolution.Facts(), barrelFileID, supportFileID)
}

func TestResolveAddsNamedReExportRelationToExportedDeclaration(t *testing.T) {
	support, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.ts",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	barrel, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/index.ts",
		Contents:   []byte("export { helper as renamed } from './support';"),
	})
	if err != nil {
		t.Fatalf("extract barrel facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{barrel, support})
	if err != nil {
		t.Fatalf("resolve TypeScript re-exports: %v", err)
	}

	barrelFileID := barrel.Facts().Nodes[1].ID
	helperID := exportedSurfaceID(t, support, "helper")
	if !hasRelation(resolution.Facts().Edges, barrelFileID, helperID, "typescript:re_exports") {
		t.Errorf("resolved facts = %+v, want re-export edge from %q to %q", resolution.Facts(), barrelFileID, helperID)
	}
}

func TestResolveFollowsAliasedReExportSurface(t *testing.T) {
	support, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/support.ts",
		Contents:   []byte("export const helper = 1;"),
	})
	if err != nil {
		t.Fatalf("extract support facts: %v", err)
	}
	barrel, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/index.ts",
		Contents:   []byte("export { helper as renamed } from './support';"),
	})
	if err != nil {
		t.Fatalf("extract barrel facts: %v", err)
	}
	main, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/main.ts",
		Contents:   []byte("import { renamed } from './index';"),
	})
	if err != nil {
		t.Fatalf("extract main facts: %v", err)
	}

	resolution, err := Resolve([]extractor.Contribution{main, barrel, support})
	if err != nil {
		t.Fatalf("resolve TypeScript re-export chain: %v", err)
	}

	mainFileID := main.Facts().Nodes[1].ID
	helperID := exportedSurfaceID(t, support, "helper")
	if !hasRelation(resolution.Facts().Edges, mainFileID, helperID, "typescript:imports_from") {
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
	_, found := findRelation(edges, sourceID, targetID, relation)
	return found
}

func findRelation(edges []graph.Edge, sourceID, targetID string, relation graph.RelationKind) (graph.Edge, bool) {
	for _, edge := range edges {
		if edge.SourceID == sourceID && edge.TargetID == targetID && edge.Relation == relation {
			return edge, true
		}
	}
	return graph.Edge{}, false
}

func hasRelationWithConfidence(edges []graph.Edge, sourceID, targetID string, relation graph.RelationKind, confidence graph.Confidence) bool {
	for _, edge := range edges {
		if edge.SourceID == sourceID && edge.TargetID == targetID && edge.Relation == relation && edge.Evidence.Confidence == confidence {
			return true
		}
	}
	return false
}

func TestExtractContainsNestedFunctionUnderItsParent(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/nested.ts",
		Contents: []byte("function outer() {\n" +
			"  function inner() { return 1; }\n" +
			"}\n"),
	})
	if err != nil {
		t.Fatalf("extract TypeScript facts: %v", err)
	}

	facts := contribution.Facts()
	if len(facts.Nodes) != 4 {
		t.Fatalf("node count = %d, want 4", len(facts.Nodes))
	}
	if len(facts.Edges) != 3 {
		t.Fatalf("edge count = %d, want 3", len(facts.Edges))
	}

	outer := facts.Nodes[2]
	inner := facts.Nodes[3]
	if got := facts.Edges[2]; got.SourceID != outer.ID || got.TargetID != inner.ID || got.Relation != "defines" {
		t.Errorf("nested definition edge = %+v, want %q -> %q", got, outer.ID, inner.ID)
	}
}

func TestExtractProducesClassMethodVariableAndLocalReferenceFacts(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/service.ts",
		Contents: []byte("class Service {\n" +
			"  run() { return helper; }\n" +
			"}\n" +
			"const helper = 1;\n"),
	})
	if err != nil {
		t.Fatalf("extract TypeScript facts: %v", err)
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
		t.Errorf("local reference edge = %+v, want %q -> %q", got, method.ID, variable.ID)
	}
}

func TestExtractProducesInterfaceTypeAliasAndTypeReferenceFacts(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/contracts.ts",
		Contents: []byte("interface Service {}\n" +
			"type ServiceAlias = Service;\n"),
	})
	if err != nil {
		t.Fatalf("extract TypeScript facts: %v", err)
	}

	facts := contribution.Facts()
	if len(facts.Nodes) != 4 {
		t.Fatalf("node count = %d, want 4", len(facts.Nodes))
	}
	if len(facts.Edges) != 4 {
		t.Fatalf("edge count = %d, want 4", len(facts.Edges))
	}

	interfaceNode := facts.Nodes[2]
	typeAlias := facts.Nodes[3]
	if interfaceNode.Kind != InterfaceNodeKind || typeAlias.Kind != TypeAliasNodeKind {
		t.Errorf("declaration kinds = %q, %q", interfaceNode.Kind, typeAlias.Kind)
	}
	if got := facts.Edges[3]; got.SourceID != typeAlias.ID || got.TargetID != interfaceNode.ID || got.Relation != "references" {
		t.Errorf("type reference edge = %+v, want %q -> %q", got, typeAlias.ID, interfaceNode.ID)
	}
}

func TestExtractUsesTSXGrammarForTSXSource(t *testing.T) {
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/component.tsx",
		Contents:   []byte("const component = <section />;"),
	})
	if err != nil {
		t.Fatalf("extract TSX facts: %v", err)
	}

	facts := contribution.Facts()
	if len(facts.Nodes) != 3 {
		t.Fatalf("node count = %d, want 3", len(facts.Nodes))
	}
	if len(facts.Edges) != 2 {
		t.Fatalf("edge count = %d, want 2", len(facts.Edges))
	}
	if got := facts.Nodes[2]; got.Kind != VariableNodeKind {
		t.Errorf("TSX declaration kind = %q, want %q", got.Kind, VariableNodeKind)
	}
}

func TestVocabularyAcceptsTypeScriptExtensionsOnly(t *testing.T) {
	vocabulary, err := New().Vocabulary()
	if err != nil {
		t.Fatalf("get TypeScript vocabulary: %v", err)
	}

	evidence := graph.FactEvidence{
		Span:       graph.SourceSpan{Path: "src/contracts.ts", StartLine: 1, StartColumn: 1, EndLine: 1, EndColumn: 1},
		FileHash:   "sha256:fixture",
		Extractor:  "typescript",
		Provenance: "static",
		Confidence: graph.ConfidenceExtracted,
	}
	facts := graph.Facts{
		Nodes: []graph.Node{
			{ID: "file:contracts", Kind: "file", Evidence: evidence},
			{ID: "typescript:interface:service", Kind: InterfaceNodeKind, Evidence: evidence},
			{ID: "typescript:type_alias:identifier", Kind: TypeAliasNodeKind, Evidence: evidence},
			{ID: "typescript:variable:count", Kind: VariableNodeKind, Evidence: evidence},
		},
		Edges: []graph.Edge{
			{SourceID: "file:contracts", TargetID: "typescript:interface:service", Relation: "defines", Evidence: evidence},
			{SourceID: "typescript:interface:service", TargetID: "typescript:type_alias:identifier", Relation: "references", Evidence: evidence},
			{SourceID: "typescript:type_alias:identifier", TargetID: "typescript:variable:count", Relation: "defines", Evidence: evidence},
		},
	}
	if err := vocabulary.Validate(facts); err != nil {
		t.Fatalf("validate TypeScript facts: %v", err)
	}

	facts.Nodes[1].Kind = "javascript:class"
	if err := vocabulary.Validate(facts); err == nil {
		t.Fatal("validate TypeScript facts accepted a JavaScript-only node kind")
	}
}

func TestExtractMatchesFocusedLocalFactFixture(t *testing.T) {
	contents := []byte(strings.TrimSpace(string(testkit.ReadFixture(t, "testdata/local_facts.ts"))))
	contribution, err := Extract(extractor.Source{
		ProjectID:  "project:fixture",
		SourcePath: "src/contracts.ts",
		Contents:   contents,
	})
	if err != nil {
		t.Fatalf("extract TypeScript fixture: %v", err)
	}

	fileSpan := graph.SourceSpan{Path: "src/contracts.ts", StartLine: 1, StartColumn: 1, EndLine: 2, EndColumn: 29}
	interfaceSpan := graph.SourceSpan{Path: "src/contracts.ts", StartLine: 1, StartColumn: 1, EndLine: 1, EndColumn: 21}
	typeAliasSpan := graph.SourceSpan{Path: "src/contracts.ts", StartLine: 2, StartColumn: 1, EndLine: 2, EndColumn: 29}
	referenceSpan := graph.SourceSpan{Path: "src/contracts.ts", StartLine: 2, StartColumn: 21, EndLine: 2, EndColumn: 28}
	hash := sha256.Sum256(contents)

	evidence := func(span graph.SourceSpan) graph.FactEvidence {
		return graph.FactEvidence{
			Span:       span,
			FileHash:   "sha256:" + hex.EncodeToString(hash[:]),
			Extractor:  "typescript@v0",
			Provenance: "static",
			Confidence: graph.ConfidenceExtracted,
		}
	}
	fileID := graph.NewNodeID("file", fileSpan)
	interfaceID := graph.NewNodeID(InterfaceNodeKind, interfaceSpan)
	typeAliasID := graph.NewNodeID(TypeAliasNodeKind, typeAliasSpan)
	want := graph.Facts{
		Nodes: []graph.Node{
			{ID: "project:fixture", Kind: "project", Label: "project:fixture", QualifiedName: "project:fixture", Evidence: evidence(fileSpan)},
			{ID: fileID, Kind: "file", Label: "src/contracts.ts", QualifiedName: "src/contracts.ts", Evidence: evidence(fileSpan)},
			{ID: interfaceID, Kind: InterfaceNodeKind, Label: "Service", QualifiedName: "src/contracts.ts::Service", Evidence: evidence(interfaceSpan)},
			{ID: typeAliasID, Kind: TypeAliasNodeKind, Label: "ServiceAlias", QualifiedName: "src/contracts.ts::ServiceAlias", Evidence: evidence(typeAliasSpan)},
		},
		Edges: []graph.Edge{
			{SourceID: "project:fixture", TargetID: fileID, Relation: "contains", Evidence: evidence(fileSpan)},
			{SourceID: fileID, TargetID: interfaceID, Relation: "defines", Evidence: evidence(interfaceSpan)},
			{SourceID: fileID, TargetID: typeAliasID, Relation: "defines", Evidence: evidence(typeAliasSpan)},
			{SourceID: typeAliasID, TargetID: interfaceID, Relation: "references", Evidence: evidence(referenceSpan)},
		},
	}
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshal expected TypeScript fixture facts: %v", err)
	}
	gotJSON, err := json.Marshal(contribution.Facts())
	if err != nil {
		t.Fatalf("marshal extracted TypeScript fixture facts: %v", err)
	}
	if err := testkit.CompareJSON(wantJSON, gotJSON); err != nil {
		t.Fatalf("compare TypeScript fixture facts: %v", err)
	}
	if diagnostics := contribution.Diagnostics(); len(diagnostics) != 0 {
		t.Errorf("fixture diagnostics = %+v, want none", diagnostics)
	}
}

func testLanguageParsesSource(t *testing.T, language *sitter.Language, source string) {
	t.Helper()

	parser := sitter.NewParser()
	defer parser.Close()
	if err := parser.SetLanguage(language); err != nil {
		t.Fatalf("set TypeScript language: %v", err)
	}

	tree := parser.Parse([]byte(source), nil)
	defer tree.Close()
	if tree.RootNode().HasError() {
		t.Fatalf("source has a syntax error: %q", source)
	}
}
