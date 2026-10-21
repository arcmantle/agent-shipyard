package javascript

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"

	sitter "github.com/tree-sitter/go-tree-sitter"
	js_grammar "github.com/tree-sitter/tree-sitter-javascript/bindings/go"
	tsx_grammar "github.com/tree-sitter/tree-sitter-typescript/bindings/go"
)

const Version = "v0"

const (
	ClassNodeKind    graph.NodeKind = "javascript:class"
	FunctionNodeKind graph.NodeKind = "javascript:function"
	MethodNodeKind   graph.NodeKind = "javascript:method"
	VariableNodeKind graph.NodeKind = "javascript:variable"
)

func New() extractor.Extractor {
	return extractorDefinition{}
}

func Language() *sitter.Language {
	return sitter.NewLanguage(js_grammar.Language())
}

type extractorDefinition struct{}

type Worker struct {
	parser    *sitter.Parser
	jsxParser *sitter.Parser
}

type declaration struct {
	id            string
	name          string
	qualifiedName string
	node          *sitter.Node
	nameStart     uint
	nameEnd       uint
}

func (extractorDefinition) Metadata() extractor.Metadata {
	return extractor.Metadata{
		Name:       "javascript",
		Version:    Version,
		Extensions: []string{".js", ".jsx", ".mjs", ".cjs"},
	}
}

func (extractorDefinition) Vocabulary() (graph.Vocabulary, error) {
	return extractor.NewLanguageVocabulary("javascript", []graph.NodeKind{
		ClassNodeKind,
		FunctionNodeKind,
		MethodNodeKind,
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
		return nil, fmt.Errorf("set JavaScript language: %w", err)
	}
	jsxParser := sitter.NewParser()
	if err := jsxParser.SetLanguage(sitter.NewLanguage(tsx_grammar.LanguageTSX())); err != nil {
		parser.Close()
		jsxParser.Close()
		return nil, fmt.Errorf("set JSX language: %w", err)
	}
	return &Worker{parser: parser, jsxParser: jsxParser}, nil
}

func (worker *Worker) Close() error {
	if worker == nil {
		return nil
	}
	if worker.parser != nil {
		worker.parser.Close()
		worker.parser = nil
	}
	if worker.jsxParser != nil {
		worker.jsxParser.Close()
		worker.jsxParser = nil
	}
	return nil
}

func (worker *Worker) Extract(source extractor.Source) (extractor.Contribution, error) {
	if source.ProjectID == "" {
		return extractor.Contribution{}, fmt.Errorf("JavaScript source project ID is empty")
	}
	if source.SourcePath == "" {
		return extractor.Contribution{}, fmt.Errorf("JavaScript source path is empty")
	}
	if worker == nil || worker.parser == nil {
		return extractor.Contribution{}, fmt.Errorf("JavaScript worker is closed")
	}

	tree := worker.parse(source)
	defer tree.Close()
	root := tree.RootNode()
	if root.HasError() {
		return extractor.Contribution{}, javaScriptParseError(source.SourcePath, root)
	}

	vocabulary, err := New().Vocabulary()
	if err != nil {
		return extractor.Contribution{}, fmt.Errorf("get JavaScript vocabulary: %w", err)
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

	declarations := collectDeclarations(source, root, fileID, source.SourcePath, &facts)
	appendLocalReferences(source, declarations, &facts)
	moduleReferences, diagnostics := collectModuleReferences(source, root, fileID)
	symbolReferences := collectSymbolReferences(source, declarations)
	symbolReferences = append(symbolReferences, collectCallReferences(source, declarations)...)
	exportedSurfaces := collectExportedSurfaces(source, root, declarations)

	return extractor.NewContribution(vocabulary, extractor.ContributionInput{
		ProjectID:            source.ProjectID,
		SourcePath:           source.SourcePath,
		Metadata:             New().Metadata(),
		Facts:                facts,
		CatalogUnits:         extractor.CatalogUnitsForSource(source, facts),
		CatalogUnitsOmitted:  source.OmitCatalogUnits,
		UnresolvedReferences: moduleReferences,
		SymbolReferences:     symbolReferences,
		ExportedSurfaces:     exportedSurfaces,
		Diagnostics:          diagnostics,
	})
}

func (worker *Worker) parse(source extractor.Source) *sitter.Tree {
	tree := worker.parser.Parse(source.Contents, nil)
	if !tree.RootNode().HasError() || !strings.EqualFold(filepath.Ext(source.SourcePath), ".jsx") {
		return tree
	}
	jsxTree := worker.jsxParser.Parse(source.Contents, nil)
	defer jsxTree.Close()
	contents := append([]byte(nil), source.Contents...)
	if !recoverJSXAttributeNames(jsxTree.RootNode(), contents) {
		return tree
	}
	recoveredTree := worker.parser.Parse(contents, nil)
	tree.Close()
	return recoveredTree
}

func recoverJSXAttributeNames(node *sitter.Node, contents []byte) bool {
	recovered := false
	if node.Kind() == "jsx_attribute" {
		name := node.NamedChild(0)
		if name != nil && name.Kind() == "property_identifier" && name.StartByte() < name.EndByte() {
			first := contents[name.StartByte()]
			if (first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z') {
				contents[name.StartByte()] = '_'
				recovered = true
			}
		}
	}
	for childIndex := uint(0); childIndex < node.ChildCount(); childIndex++ {
		recovered = recoverJSXAttributeNames(node.Child(childIndex), contents) || recovered
	}
	return recovered
}

func javaScriptParseError(sourcePath string, root *sitter.Node) error {
	node := firstParseErrorNode(root)
	if node == nil {
		return fmt.Errorf("parse JavaScript source %q: parser reported an unspecified error", sourcePath)
	}
	start := node.StartPosition()
	end := node.EndPosition()
	reason := node.Kind()
	if node.IsMissing() {
		reason = "missing " + reason
	}
	return fmt.Errorf("parse JavaScript source %q at %d:%d-%d:%d: %s", sourcePath, start.Row+1, start.Column+1, end.Row+1, end.Column+1, reason)
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

func collectDeclarations(source extractor.Source, node *sitter.Node, parentID, parentQualifiedName string, facts *graph.Facts) []declaration {
	declarations := make([]declaration, 0)
	for childIndex := uint(0); childIndex < node.NamedChildCount(); childIndex++ {
		child := node.NamedChild(childIndex)
		kind, ok := declarationKind(child.Kind())
		if !ok {
			declarations = append(declarations, collectDeclarations(source, child, parentID, parentQualifiedName, facts)...)
			continue
		}

		name := child.ChildByFieldName("name")
		if name == nil {
			declarations = append(declarations, collectDeclarations(source, child, parentID, parentQualifiedName, facts)...)
			continue
		}

		evidence := evidenceFor(source, child)
		declarationID := graph.NewNodeID(kind, evidence.Span)
		declarationName := name.Utf8Text(source.Contents)
		qualifiedName := qualifyName(source.SourcePath, parentQualifiedName, declarationName)
		facts.Nodes = append(facts.Nodes, graph.Node{ID: declarationID, Kind: kind, Label: declarationName, QualifiedName: qualifiedName, Evidence: evidence})
		facts.Edges = append(facts.Edges, graph.Edge{
			SourceID: parentID,
			TargetID: declarationID,
			Relation: "defines",
			Evidence: evidence,
		})
		declarations = append(declarations, declaration{
			id:            declarationID,
			name:          declarationName,
			qualifiedName: qualifiedName,
			node:          child,
			nameStart:     name.StartByte(),
			nameEnd:       name.EndByte(),
		})
		declarations = append(declarations, collectDeclarations(source, child, declarationID, qualifiedName, facts)...)
	}
	return declarations
}

func qualifyName(sourcePath, parentQualifiedName, name string) string {
	if parentQualifiedName == sourcePath {
		return sourcePath + "::" + name
	}
	return parentQualifiedName + "." + name
}

func appendLocalReferences(source extractor.Source, declarations []declaration, facts *graph.Facts) {
	byName := make(map[string]declaration, len(declarations))
	declarationNames := make(map[uint]uint, len(declarations))
	for _, declaration := range declarations {
		byName[declaration.name] = declaration
		declarationNames[declaration.nameStart] = declaration.nameEnd
	}

	for _, declaration := range declarations {
		appendReferencesFromNode(source, declaration.node, declaration.id, byName, declarationNames, facts)
	}
}

func collectSymbolReferences(source extractor.Source, declarations []declaration) []extractor.SymbolReference {
	references := make([]extractor.SymbolReference, 0)
	for _, declaration := range declarations {
		if declaration.node.Kind() != "class_declaration" {
			continue
		}
		for childIndex := uint(0); childIndex < declaration.node.NamedChildCount(); childIndex++ {
			heritage := declaration.node.NamedChild(childIndex)
			if heritage.Kind() != "class_heritage" {
				continue
			}
			appendSymbolReferences(source, heritage, declaration.id, ExtendsRelation, &references)
		}
	}
	return references
}

func appendSymbolReferences(source extractor.Source, node *sitter.Node, sourceID string, relation graph.RelationKind, references *[]extractor.SymbolReference) {
	for childIndex := uint(0); childIndex < node.NamedChildCount(); childIndex++ {
		child := node.NamedChild(childIndex)
		if child.Kind() == "identifier" {
			*references = append(*references, extractor.SymbolReference{
				SourceID: sourceID,
				Target:   child.Utf8Text(source.Contents),
				Relation: relation,
				Evidence: evidenceFor(source, child),
			})
			continue
		}
		appendSymbolReferences(source, child, sourceID, relation, references)
	}
}

func collectCallReferences(source extractor.Source, declarations []declaration) []extractor.SymbolReference {
	references := make([]extractor.SymbolReference, 0)
	for _, declaration := range declarations {
		if declaration.node.Kind() != "function_declaration" && declaration.node.Kind() != "method_definition" {
			continue
		}
		appendCallReferences(source, declaration.node, declaration.id, &references)
	}
	return references
}

func appendCallReferences(source extractor.Source, node *sitter.Node, sourceID string, references *[]extractor.SymbolReference) {
	for childIndex := uint(0); childIndex < node.NamedChildCount(); childIndex++ {
		child := node.NamedChild(childIndex)
		if _, nestedDeclaration := declarationKind(child.Kind()); nestedDeclaration {
			continue
		}
		if child.Kind() == "call_expression" {
			function := child.ChildByFieldName("function")
			if function != nil && function.Kind() == "identifier" {
				*references = append(*references, extractor.SymbolReference{
					SourceID: sourceID,
					Target:   function.Utf8Text(source.Contents),
					Relation: CallsRelation,
					Evidence: evidenceFor(source, function),
				})
			}
		}
		appendCallReferences(source, child, sourceID, references)
	}
}

const maxDynamicSpecifierCandidates = 100

func collectModuleReferences(source extractor.Source, node *sitter.Node, fileID string) ([]extractor.UnresolvedReference, []extractor.Diagnostic) {
	references := make([]extractor.UnresolvedReference, 0)
	diagnostics := make([]extractor.Diagnostic, 0)
	var visit func(*sitter.Node)
	visit = func(current *sitter.Node) {
		kind, found := moduleReferenceKind(source, current)
		if found {
			specifiers, diagnostic, found := moduleSpecifiers(source, current)
			if diagnostic != "" {
				diagnostics = append(diagnostics, extractor.Diagnostic{Severity: extractor.DiagnosticWarning, Message: fmt.Sprintf("JavaScript dynamic module specifier in %q %s", source.SourcePath, diagnostic)})
			}
			if found {
				for _, specifier := range specifiers {
					references = append(references, extractor.UnresolvedReference{
						SourceID:  fileID,
						Target:    specifier.target,
						Kind:      kind,
						Ambiguous: specifier.ambiguous,
						Bindings:  moduleBindings(source, current),
					})
				}
			}
		}

		for childIndex := uint(0); childIndex < current.NamedChildCount(); childIndex++ {
			visit(current.NamedChild(childIndex))
		}
	}
	visit(node)
	return references, diagnostics
}

func moduleBindings(source extractor.Source, node *sitter.Node) []extractor.ModuleBinding {
	bindings := make([]extractor.ModuleBinding, 0)
	if node.Kind() == "import_statement" {
		for childIndex := uint(0); childIndex < node.NamedChildCount(); childIndex++ {
			clause := node.NamedChild(childIndex)
			if clause.Kind() != "import_clause" {
				continue
			}
			for bindingIndex := uint(0); bindingIndex < clause.NamedChildCount(); bindingIndex++ {
				binding := clause.NamedChild(bindingIndex)
				switch binding.Kind() {
				case "identifier":
					bindings = append(bindings, extractor.ModuleBinding{
						ImportedName: "default",
						LocalName:    binding.Utf8Text(source.Contents),
					})
				case "named_imports":
					for specifierIndex := uint(0); specifierIndex < binding.NamedChildCount(); specifierIndex++ {
						specifier := binding.NamedChild(specifierIndex)
						if name := specifier.ChildByFieldName("name"); name != nil {
							localName := ""
							if alias := specifier.ChildByFieldName("alias"); alias != nil {
								localName = alias.Utf8Text(source.Contents)
							}
							bindings = append(bindings, extractor.ModuleBinding{
								ImportedName: name.Utf8Text(source.Contents),
								LocalName:    localName,
							})
						}
					}
				case "namespace_import":
					bindings = append(bindings, extractor.ModuleBinding{ImportedName: "*"})
				}
			}
		}
		return bindings
	}

	if node.Kind() == "export_statement" {
		for childIndex := uint(0); childIndex < node.NamedChildCount(); childIndex++ {
			clause := node.NamedChild(childIndex)
			switch clause.Kind() {
			case "export_clause":
				for specifierIndex := uint(0); specifierIndex < clause.NamedChildCount(); specifierIndex++ {
					specifier := clause.NamedChild(specifierIndex)
					if name := specifier.ChildByFieldName("name"); name != nil {
						exportedName := name.Utf8Text(source.Contents)
						if alias := specifier.ChildByFieldName("alias"); alias != nil {
							exportedName = alias.Utf8Text(source.Contents)
						}
						bindings = append(bindings, extractor.ModuleBinding{
							ImportedName: name.Utf8Text(source.Contents),
							ExportedName: exportedName,
						})
					}
				}
			case "namespace_export":
				exportedName := "*"
				if clause.NamedChildCount() > 0 {
					exportedName = clause.NamedChild(0).Utf8Text(source.Contents)
				}
				bindings = append(bindings, extractor.ModuleBinding{ImportedName: "*", ExportedName: exportedName})
			}
		}
		if strings.HasPrefix(strings.TrimSpace(node.Utf8Text(source.Contents)), "export *") && len(bindings) == 0 {
			bindings = append(bindings, extractor.ModuleBinding{ImportedName: "*", ExportedName: "*"})
		}
	}
	return bindings
}

func collectExportedSurfaces(source extractor.Source, root *sitter.Node, declarations []declaration) []extractor.ExportedSurface {
	surfaces := make([]extractor.ExportedSurface, 0)
	byName := make(map[string]declaration, len(declarations))
	for _, declaration := range declarations {
		byName[declaration.name] = declaration
	}
	seen := make(map[string]struct{})
	appendSurface := func(name string, declaration declaration) {
		key := name + "\x00" + declaration.id
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		surfaces = append(surfaces, extractor.ExportedSurface{NodeID: declaration.id, Name: name})
	}
	var visit func(*sitter.Node)
	visit = func(current *sitter.Node) {
		if current.Kind() == "export_statement" {
			if exported := current.ChildByFieldName("declaration"); exported != nil {
				for _, declaration := range declarations {
					if declaration.node.StartByte() >= exported.StartByte() && declaration.node.EndByte() <= exported.EndByte() {
						name := declaration.name
						if strings.HasPrefix(strings.TrimSpace(current.Utf8Text(source.Contents)), "export default") {
							name = "default"
						}
						appendSurface(name, declaration)
					}
				}
			} else if current.ChildByFieldName("source") == nil {
				for childIndex := uint(0); childIndex < current.NamedChildCount(); childIndex++ {
					clause := current.NamedChild(childIndex)
					if clause.Kind() != "export_clause" {
						continue
					}
					for specifierIndex := uint(0); specifierIndex < clause.NamedChildCount(); specifierIndex++ {
						specifier := clause.NamedChild(specifierIndex)
						name := specifier.ChildByFieldName("name")
						if name == nil {
							continue
						}
						if declaration, found := byName[name.Utf8Text(source.Contents)]; found {
							exportedName := name.Utf8Text(source.Contents)
							if alias := specifier.ChildByFieldName("alias"); alias != nil {
								exportedName = alias.Utf8Text(source.Contents)
							}
							appendSurface(exportedName, declaration)
						}
					}
				}
			}
		}
		for childIndex := uint(0); childIndex < current.NamedChildCount(); childIndex++ {
			visit(current.NamedChild(childIndex))
		}
	}
	visit(root)
	return surfaces
}

func moduleReferenceKind(source extractor.Source, node *sitter.Node) (extractor.ModuleReferenceKind, bool) {
	switch node.Kind() {
	case "import_statement":
		return extractor.ModuleReferenceImport, true
	case "export_statement":
		// A declaration export has no source clause and re-exports nothing.
		if node.ChildByFieldName("source") == nil {
			return "", false
		}
		return extractor.ModuleReferenceReExport, true
	case "call_expression":
		function := node.ChildByFieldName("function")
		arguments := node.ChildByFieldName("arguments")
		if function == nil || arguments == nil || arguments.NamedChildCount() != 1 {
			return "", false
		}
		switch function.Utf8Text(source.Contents) {
		case "import":
			return extractor.ModuleReferenceImport, true
		case "require":
			if function.Kind() == "identifier" {
				return extractor.ModuleReferenceRequire, true
			}
		}
		return "", false
	default:
		return "", false
	}
}

type moduleSpecifier struct {
	target    string
	ambiguous bool
}

func moduleSpecifiers(source extractor.Source, node *sitter.Node) ([]moduleSpecifier, string, bool) {
	if node.Kind() != "call_expression" {
		target, found := staticModuleSpecifier(source, node)
		if !found {
			return nil, "", false
		}
		return []moduleSpecifier{{target: target}}, "", true
	}

	arguments := node.ChildByFieldName("arguments")
	if arguments == nil || arguments.NamedChildCount() != 1 {
		return nil, "is unbounded", false
	}
	targets, dynamic, status := stringSpecifierCandidates(source, arguments.NamedChild(0))
	if status != "" {
		return nil, status, false
	}
	if len(targets) > maxDynamicSpecifierCandidates {
		return nil, fmt.Sprintf("exceeds the limit of %d candidates", maxDynamicSpecifierCandidates), false
	}
	specifiers := make([]moduleSpecifier, len(targets))
	for index, target := range targets {
		specifiers[index] = moduleSpecifier{target: target, ambiguous: dynamic}
	}
	return specifiers, "", true
}

func staticModuleSpecifier(source extractor.Source, node *sitter.Node) (string, bool) {
	specifier := node
	if node.Kind() != "string" {
		specifier = node.ChildByFieldName("source")
	}
	if specifier == nil || specifier.Kind() != "string" {
		return "", false
	}

	raw := specifier.Utf8Text(source.Contents)
	if strings.HasPrefix(raw, "'") && strings.HasSuffix(raw, "'") {
		raw = `"` + raw[1:len(raw)-1] + `"`
	}
	target, err := strconv.Unquote(raw)
	return target, err == nil
}

func stringSpecifierCandidates(source extractor.Source, node *sitter.Node) ([]string, bool, string) {
	if node.Kind() == "string" {
		target, found := staticModuleSpecifier(source, node)
		if !found {
			return nil, false, "is unsupported"
		}
		return []string{target}, false, ""
	}

	switch node.Kind() {
	case "parenthesized_expression":
		if node.NamedChildCount() != 1 {
			return nil, false, "is unsupported"
		}
		return stringSpecifierCandidates(source, node.NamedChild(0))
	case "ternary_expression":
		consequence := node.ChildByFieldName("consequence")
		alternative := node.ChildByFieldName("alternative")
		if consequence == nil || alternative == nil {
			return nil, false, "is unsupported"
		}
		left, _, status := stringSpecifierCandidates(source, consequence)
		if status != "" {
			return nil, false, status
		}
		right, _, status := stringSpecifierCandidates(source, alternative)
		if status != "" {
			return nil, false, status
		}
		return uniqueSpecifiers(append(left, right...)), true, ""
	case "binary_expression":
		left := node.ChildByFieldName("left")
		right := node.ChildByFieldName("right")
		if left == nil || right == nil || strings.TrimSpace(string(source.Contents[left.EndByte():right.StartByte()])) != "+" {
			return nil, false, "is unbounded"
		}
		leftTargets, _, status := stringSpecifierCandidates(source, left)
		if status != "" {
			return nil, false, status
		}
		rightTargets, _, status := stringSpecifierCandidates(source, right)
		if status != "" {
			return nil, false, status
		}
		candidates := make([]string, 0, len(leftTargets)*len(rightTargets))
		for _, leftTarget := range leftTargets {
			for _, rightTarget := range rightTargets {
				candidates = append(candidates, leftTarget+rightTarget)
			}
		}
		return uniqueSpecifiers(candidates), len(candidates) > 1, ""
	default:
		return nil, false, "is unbounded"
	}
}

func uniqueSpecifiers(specifiers []string) []string {
	seen := make(map[string]struct{}, len(specifiers))
	unique := make([]string, 0, len(specifiers))
	for _, specifier := range specifiers {
		if _, found := seen[specifier]; found {
			continue
		}
		seen[specifier] = struct{}{}
		unique = append(unique, specifier)
	}
	return unique
}

func appendReferencesFromNode(source extractor.Source, node *sitter.Node, sourceID string, byName map[string]declaration, declarationNames map[uint]uint, facts *graph.Facts) {
	for childIndex := uint(0); childIndex < node.NamedChildCount(); childIndex++ {
		child := node.NamedChild(childIndex)
		if _, isDeclaration := declarationKind(child.Kind()); isDeclaration {
			continue
		}
		if child.Kind() == "identifier" {
			if end, isDeclarationName := declarationNames[child.StartByte()]; isDeclarationName && end == child.EndByte() {
				continue
			}
			if target, found := byName[child.Utf8Text(source.Contents)]; found {
				facts.Edges = append(facts.Edges, graph.Edge{
					SourceID: sourceID,
					TargetID: target.id,
					Relation: "references",
					Evidence: evidenceFor(source, child),
				})
			}
		}
		appendReferencesFromNode(source, child, sourceID, byName, declarationNames, facts)
	}
}

func declarationKind(kind string) (graph.NodeKind, bool) {
	switch kind {
	case "class_declaration":
		return ClassNodeKind, true
	case "function_declaration":
		return FunctionNodeKind, true
	case "method_definition":
		return MethodNodeKind, true
	case "variable_declarator":
		return VariableNodeKind, true
	default:
		return "", false
	}
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
		Extractor:  "javascript@" + Version,
		Provenance: "static",
		Confidence: graph.ConfidenceExtracted,
	}
}
