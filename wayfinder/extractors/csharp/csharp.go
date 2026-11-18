package csharp

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"

	sitter "github.com/tree-sitter/go-tree-sitter"
	csharp_grammar "github.com/tree-sitter/tree-sitter-c-sharp/bindings/go"
)

const Version = "v0"

const (
	NamespaceNodeKind   graph.NodeKind = "csharp:namespace"
	ClassNodeKind       graph.NodeKind = "csharp:class"
	StructNodeKind      graph.NodeKind = "csharp:struct"
	InterfaceNodeKind   graph.NodeKind = "csharp:interface"
	RecordNodeKind      graph.NodeKind = "csharp:record"
	EnumNodeKind        graph.NodeKind = "csharp:enum"
	DelegateNodeKind    graph.NodeKind = "csharp:delegate"
	TypeAliasNodeKind   graph.NodeKind = "csharp:type_alias"
	MethodNodeKind      graph.NodeKind = "csharp:method"
	ConstructorNodeKind graph.NodeKind = "csharp:constructor"
	// ImportNodeKind is a namespace or static `using` directive. An alias
	// directive is recorded as a TypeAliasNodeKind node instead.
	ImportNodeKind graph.NodeKind = "csharp:import"
	// VariableNodeKind covers fields, constants, and local variables. Constants
	// are variables whose declaration carries the const modifier.
	VariableNodeKind graph.NodeKind = "csharp:variable"
)

// StaticBinding marks the import binding of a `using static` directive.
const StaticBinding = "static"

func New() extractor.Extractor {
	return extractorDefinition{}
}

func Language() *sitter.Language {
	return sitter.NewLanguage(csharp_grammar.Language())
}

type extractorDefinition struct{}

type Worker struct {
	parser *sitter.Parser
}

func (extractorDefinition) Metadata() extractor.Metadata {
	return extractor.Metadata{
		Name:       "csharp",
		Version:    Version,
		Extensions: []string{".cs"},
	}
}

func (extractorDefinition) Vocabulary() (graph.Vocabulary, error) {
	return extractor.NewLanguageVocabulary("csharp", []graph.NodeKind{
		NamespaceNodeKind,
		ClassNodeKind,
		StructNodeKind,
		InterfaceNodeKind,
		RecordNodeKind,
		EnumNodeKind,
		DelegateNodeKind,
		TypeAliasNodeKind,
		MethodNodeKind,
		ConstructorNodeKind,
		ImportNodeKind,
		VariableNodeKind,
	})
}

func Extract(source extractor.Source) (extractor.Contribution, error) {
	worker, err := NewWorker()
	if err != nil {
		return extractor.Contribution{}, err
	}
	defer worker.Close()
	return worker.Extract(source)
}

func NewWorker() (*Worker, error) {
	parser := sitter.NewParser()
	if err := parser.SetLanguage(Language()); err != nil {
		parser.Close()
		return nil, fmt.Errorf("set C# language: %w", err)
	}
	return &Worker{parser: parser}, nil
}

func (worker *Worker) Close() error {
	if worker == nil {
		return nil
	}
	if worker.parser != nil {
		worker.parser.Close()
		worker.parser = nil
	}
	return nil
}

func (worker *Worker) Extract(source extractor.Source) (extractor.Contribution, error) {
	if source.ProjectID == "" {
		return extractor.Contribution{}, fmt.Errorf("C# source project ID is empty")
	}
	if source.SourcePath == "" {
		return extractor.Contribution{}, fmt.Errorf("C# source path is empty")
	}
	if worker == nil || worker.parser == nil {
		return extractor.Contribution{}, fmt.Errorf("C# worker is closed")
	}

	tree := worker.parser.Parse(source.Contents, nil)
	defer tree.Close()
	root := tree.RootNode()
	if root.HasError() {
		return extractor.Contribution{}, parseError(source.SourcePath, root)
	}

	vocabulary, err := New().Vocabulary()
	if err != nil {
		return extractor.Contribution{}, fmt.Errorf("get C# vocabulary: %w", err)
	}

	fileEvidence := evidenceFor(source, root)
	fileID := graph.NewNodeID("file", fileEvidence.Span)
	facts := graph.Facts{
		Nodes: []graph.Node{
			{ID: source.ProjectID, Kind: "project", Label: source.ProjectID, QualifiedName: source.ProjectID, Evidence: fileEvidence},
			{ID: fileID, Kind: "file", Label: source.SourcePath, QualifiedName: source.SourcePath, Evidence: fileEvidence},
		},
		Edges: []graph.Edge{{
			SourceID: source.ProjectID,
			TargetID: fileID,
			Relation: "contains",
			Evidence: fileEvidence,
		}},
	}
	var references []extractor.UnresolvedReference
	var symbols []extractor.SymbolReference
	collectDeclarations(source, root, fileID, source.SourcePath, &facts, &references, &symbols)

	return extractor.NewContribution(vocabulary, extractor.ContributionInput{
		ProjectID:            source.ProjectID,
		SourcePath:           source.SourcePath,
		Metadata:             New().Metadata(),
		Facts:                facts,
		SymbolReferences:     symbols,
		CatalogUnits:         extractor.CatalogUnitsForSource(source, facts),
		CatalogUnitsOmitted:  source.OmitCatalogUnits,
		UnresolvedReferences: references,
		ExportedSurfaces:     importableSurfaces(facts.Nodes),
	})
}

// collectDeclarations records namespaces, types, delegates, type aliases, methods,
// constructors, and variable facts. Each declaration is owned by its enclosing declaration or the
// file, and its qualified name extends the owner's. Parameters and properties are
// not declarations.
//
// Every namespace, static, and alias `using` directive is also recorded as an
// unresolved import reference from the node that carries its source evidence.
// `extern alias` is not an import.
func collectDeclarations(source extractor.Source, node *sitter.Node, ownerID, ownerName string, facts *graph.Facts, references *[]extractor.UnresolvedReference, symbols *[]extractor.SymbolReference) {
	for childIndex := uint(0); childIndex < node.NamedChildCount(); childIndex++ {
		child := node.NamedChild(childIndex)
		kind, found := declarationKind(source, child)
		if !found && child.Kind() == "using_directive" {
			appendImport(source, child, ownerID, ownerName, facts, references)
			continue
		}
		if !found {
			switch child.Kind() {
			case "declaration_list":
				collectDeclarations(source, child, ownerID, ownerName, facts, references, symbols)
			case "field_declaration":
				collectVariableDeclarators(source, child, ownerID, ownerName, facts)
			case "global_statement", "property_declaration", "indexer_declaration", "destructor_declaration", "operator_declaration", "conversion_operator_declaration":
				// Properties and indexers are not nodes, but locals in their
				// accessors belong to the enclosing declaration.
				collectLocalVariables(source, child, ownerID, ownerName, facts)
			}
			continue
		}
		name := child.ChildByFieldName("name")
		if name == nil {
			continue
		}
		evidence := evidenceFor(source, child)
		id := graph.NewNodeID(kind, evidence.Span)
		label := name.Utf8Text(source.Contents)
		qualifiedName := qualifyName(source.SourcePath, ownerName, label)
		facts.Nodes = append(facts.Nodes, graph.Node{ID: id, Kind: kind, Label: label, QualifiedName: qualifiedName, Evidence: evidence})
		facts.Edges = append(facts.Edges, graph.Edge{SourceID: ownerID, TargetID: id, Relation: "defines", Evidence: evidence})
		if child.Kind() == "using_directive" {
			if reference, ok := importReference(source, child, id); ok {
				*references = append(*references, reference)
			}
			continue
		}
		if child.Kind() == "file_scoped_namespace_declaration" {
			// A file-scoped namespace owns every later sibling declaration.
			ownerID, ownerName = id, qualifiedName
			continue
		}
		collectReferences(source, child, id, symbols)
		collectDeclarations(source, child, id, qualifiedName, facts, references, symbols)
		if kind == MethodNodeKind || kind == ConstructorNodeKind {
			collectLocalVariables(source, child, id, qualifiedName, facts)
		}
	}
}

// appendImport records a non-alias `using` directive as an import node owned by
// its enclosing namespace or file.
func appendImport(source extractor.Source, directive *sitter.Node, ownerID, ownerName string, facts *graph.Facts, references *[]extractor.UnresolvedReference) {
	evidence := evidenceFor(source, directive)
	id := graph.NewNodeID(ImportNodeKind, evidence.Span)
	reference, ok := importReference(source, directive, id)
	if !ok {
		return
	}
	qualifier := "using "
	if hasToken(directive, "global") {
		qualifier = "global using "
	}
	if hasToken(directive, "static") {
		qualifier += "static "
	}
	facts.Nodes = append(facts.Nodes, graph.Node{ID: id, Kind: ImportNodeKind, Label: reference.Target, QualifiedName: qualifyName(source.SourcePath, ownerName, qualifier+reference.Target), Evidence: evidence})
	facts.Edges = append(facts.Edges, graph.Edge{SourceID: ownerID, TargetID: id, Relation: "defines", Evidence: evidence})
	*references = append(*references, reference)
}

// importReference describes the target of a `using` directive. A namespace
// import has no bindings, a static import binds StaticBinding, and an alias
// import binds its local name.
func importReference(source extractor.Source, directive *sitter.Node, sourceID string) (extractor.UnresolvedReference, bool) {
	var target *sitter.Node
	alias := directive.ChildByFieldName("name")
	for childIndex := uint(0); childIndex < directive.NamedChildCount(); childIndex++ {
		child := directive.NamedChild(childIndex)
		if alias == nil || child.Id() != alias.Id() {
			target = child
		}
	}
	if target == nil {
		return extractor.UnresolvedReference{}, false
	}
	name := strings.TrimPrefix(strings.Join(strings.Fields(target.Utf8Text(source.Contents)), ""), "global::")
	reference := extractor.UnresolvedReference{SourceID: sourceID, Target: name, Kind: extractor.ModuleReferenceImport}
	switch {
	case alias != nil:
		reference.Bindings = []extractor.ModuleBinding{{ImportedName: name, LocalName: alias.Utf8Text(source.Contents)}}
	case hasToken(directive, "static"):
		reference.Bindings = []extractor.ModuleBinding{{ImportedName: name, ExportedName: StaticBinding}}
	}
	return reference, true
}

func hasToken(node *sitter.Node, kind string) bool {
	for childIndex := uint(0); childIndex < node.ChildCount(); childIndex++ {
		if child := node.Child(childIndex); !child.IsNamed() && child.Kind() == kind {
			return true
		}
	}
	return false
}

// collectLocalVariables records the variables declared anywhere inside a method,
// constructor, or top-level statement, owned by that enclosing declaration.
func collectLocalVariables(source extractor.Source, node *sitter.Node, ownerID, ownerName string, facts *graph.Facts) {
	for childIndex := uint(0); childIndex < node.NamedChildCount(); childIndex++ {
		child := node.NamedChild(childIndex)
		switch child.Kind() {
		case "variable_declaration":
			collectVariableDeclarators(source, child, ownerID, ownerName, facts)
		case "declaration_expression", "declaration_pattern", "catch_declaration":
			// `out var x`, `is Foo x`, and `catch (E x)`.
			if name := child.ChildByFieldName("name"); name != nil {
				appendVariable(source, child, name, ownerID, ownerName, facts)
			}
		case "foreach_statement":
			if left := child.ChildByFieldName("left"); left != nil && left.Kind() == "identifier" {
				appendVariable(source, left, left, ownerID, ownerName, facts)
			}
		}
		collectLocalVariables(source, child, ownerID, ownerName, facts)
	}
}

// collectVariableDeclarators records one variable per declarator below node, so
// `int a, b;` yields two variables. It does not descend into initializers.
func collectVariableDeclarators(source extractor.Source, node *sitter.Node, ownerID, ownerName string, facts *graph.Facts) {
	for childIndex := uint(0); childIndex < node.NamedChildCount(); childIndex++ {
		child := node.NamedChild(childIndex)
		switch child.Kind() {
		case "variable_declaration":
			collectVariableDeclarators(source, child, ownerID, ownerName, facts)
		case "variable_declarator":
			if name := child.ChildByFieldName("name"); name != nil {
				appendVariable(source, child, name, ownerID, ownerName, facts)
			} else if first := child.NamedChild(0); first != nil && first.Kind() == "identifier" {
				appendVariable(source, child, first, ownerID, ownerName, facts)
			}
		}
	}
}

func appendVariable(source extractor.Source, declaration, name *sitter.Node, ownerID, ownerName string, facts *graph.Facts) {
	evidence := evidenceFor(source, declaration)
	id := graph.NewNodeID(VariableNodeKind, evidence.Span)
	label := name.Utf8Text(source.Contents)
	facts.Nodes = append(facts.Nodes, graph.Node{ID: id, Kind: VariableNodeKind, Label: label, QualifiedName: qualifyName(source.SourcePath, ownerName, label), Evidence: evidence})
	facts.Edges = append(facts.Edges, graph.Edge{SourceID: ownerID, TargetID: id, Relation: "defines", Evidence: evidence})
}

func declarationKind(source extractor.Source, node *sitter.Node) (graph.NodeKind, bool) {
	switch node.Kind() {
	case "namespace_declaration", "file_scoped_namespace_declaration":
		return NamespaceNodeKind, true
	case "class_declaration":
		return ClassNodeKind, true
	case "struct_declaration":
		return StructNodeKind, true
	case "interface_declaration":
		return InterfaceNodeKind, true
	case "record_declaration", "record_struct_declaration":
		return RecordNodeKind, true
	case "enum_declaration":
		return EnumNodeKind, true
	case "delegate_declaration":
		return DelegateNodeKind, true
	case "method_declaration":
		return MethodNodeKind, true
	case "constructor_declaration":
		return ConstructorNodeKind, true
	case "using_directive":
		// Only `using Alias = Target;` declares a name.
		return TypeAliasNodeKind, node.ChildByFieldName("name") != nil
	}
	return "", false
}

func qualifyName(sourcePath, ownerName, name string) string {
	if ownerName == sourcePath {
		return sourcePath + "::" + name
	}
	return ownerName + "." + name
}

func parseError(sourcePath string, root *sitter.Node) error {
	node := firstParseErrorNode(root)
	if node == nil {
		return fmt.Errorf("parse C# source %q: parser reported an unspecified error", sourcePath)
	}
	start := node.StartPosition()
	end := node.EndPosition()
	reason := node.Kind()
	if node.IsMissing() {
		reason = "missing " + reason
	}
	return fmt.Errorf("parse C# source %q at %d:%d-%d:%d: %s", sourcePath, start.Row+1, start.Column+1, end.Row+1, end.Column+1, reason)
}

func firstParseErrorNode(node *sitter.Node) *sitter.Node {
	for childIndex := uint(0); childIndex < node.ChildCount(); childIndex++ {
		child := node.Child(childIndex)
		if child.HasError() || child.IsMissing() {
			if errorNode := firstParseErrorNode(child); errorNode != nil {
				return errorNode
			}
		}
	}
	if node.IsError() || node.IsMissing() {
		return node
	}
	return nil
}

func evidenceFor(source extractor.Source, node *sitter.Node) graph.FactEvidence {
	start := node.StartPosition()
	end := node.EndPosition()
	hash := sha256.Sum256(source.Contents)

	return graph.FactEvidence{
		Span: graph.SourceSpan{
			Path:        source.SourcePath,
			StartLine:   int(start.Row) + 1,
			StartColumn: int(start.Column) + 1,
			EndLine:     int(end.Row) + 1,
			EndColumn:   int(end.Column) + 1,
		},
		FileHash:   "sha256:" + hex.EncodeToString(hash[:]),
		Extractor:  "csharp@" + Version,
		Provenance: "static",
		Confidence: graph.ConfidenceExtracted,
	}
}

// importableSurfaces lists the namespaces, types, and methods other files can
// import, reference, or call. A change to them re-resolves the files that
// depend on this one.
func importableSurfaces(nodes []graph.Node) []extractor.ExportedSurface {
	var surfaces []extractor.ExportedSurface
	for _, node := range nodes {
		switch node.Kind {
		case NamespaceNodeKind, ClassNodeKind, StructNodeKind, InterfaceNodeKind, RecordNodeKind, EnumNodeKind, DelegateNodeKind, MethodNodeKind:
			surfaces = append(surfaces, extractor.ExportedSurface{NodeID: node.ID, Name: node.Label})
		}
	}
	return surfaces
}
