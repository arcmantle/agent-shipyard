package typescript

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"

	sitter "github.com/tree-sitter/go-tree-sitter"
	typescriptgrammar "github.com/tree-sitter/tree-sitter-typescript/bindings/go"
)

const Version = "v0"

const (
	ClassNodeKind     graph.NodeKind = "typescript:class"
	FunctionNodeKind  graph.NodeKind = "typescript:function"
	MethodNodeKind    graph.NodeKind = "typescript:method"
	InterfaceNodeKind graph.NodeKind = "typescript:interface"
	TypeAliasNodeKind graph.NodeKind = "typescript:type_alias"
	VariableNodeKind  graph.NodeKind = "typescript:variable"
)

func New() extractor.Extractor {
	return extractorDefinition{}
}

func Language() *sitter.Language {
	return sitter.NewLanguage(typescriptgrammar.LanguageTypescript())
}

func TSXLanguage() *sitter.Language {
	return sitter.NewLanguage(typescriptgrammar.LanguageTSX())
}

type extractorDefinition struct{}

type Worker struct {
	typescriptParser *sitter.Parser
	tsxParser        *sitter.Parser
}

type declaration struct {
	id            string
	name          string
	qualifiedName string
	node          *sitter.Node
	nameStart     uint
	nameEnd       uint
}

var (
	typeQueryCallPattern        = regexp.MustCompile(`typeof[[:space:]]+import[[:space:]]*\([[:space:]]*(?:'([^'\\]|\\.)*'|"([^"\\]|\\.)*")[[:space:]]*\)`)
	typeOnlyStarReExportPattern = regexp.MustCompile(`\bexport([[:space:]]+)type([[:space:]]+)\*([[:space:]]+)from\b`)
)

func (extractorDefinition) Metadata() extractor.Metadata {
	return extractor.Metadata{
		Name:       "typescript",
		Version:    Version,
		Extensions: []string{".ts", ".tsx", ".mts", ".cts"},
	}
}

func (extractorDefinition) Vocabulary() (graph.Vocabulary, error) {
	return extractor.NewLanguageVocabulary("typescript", []graph.NodeKind{
		ClassNodeKind,
		FunctionNodeKind,
		MethodNodeKind,
		InterfaceNodeKind,
		TypeAliasNodeKind,
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
	typescriptParser := sitter.NewParser()
	if err := typescriptParser.SetLanguage(Language()); err != nil {
		typescriptParser.Close()
		return nil, fmt.Errorf("set TypeScript language: %w", err)
	}
	tsxParser := sitter.NewParser()
	if err := tsxParser.SetLanguage(TSXLanguage()); err != nil {
		typescriptParser.Close()
		tsxParser.Close()
		return nil, fmt.Errorf("set TSX language: %w", err)
	}
	return &Worker{typescriptParser: typescriptParser, tsxParser: tsxParser}, nil
}

func (worker *Worker) Close() error {
	if worker == nil {
		return nil
	}
	if worker.typescriptParser != nil {
		worker.typescriptParser.Close()
		worker.typescriptParser = nil
	}
	if worker.tsxParser != nil {
		worker.tsxParser.Close()
		worker.tsxParser = nil
	}
	return nil
}

func (worker *Worker) Extract(source extractor.Source) (extractor.Contribution, error) {
	if source.ProjectID == "" {
		return extractor.Contribution{}, fmt.Errorf("TypeScript source project ID is empty")
	}
	if source.SourcePath == "" {
		return extractor.Contribution{}, fmt.Errorf("TypeScript source path is empty")
	}

	parser := worker.parserForPath(source.SourcePath)
	if parser == nil {
		return extractor.Contribution{}, fmt.Errorf("TypeScript worker is closed")
	}
	tree := parseTypeScript(parser, source.Contents)
	defer tree.Close()
	root := tree.RootNode()
	if root.HasError() {
		return extractor.Contribution{}, typeScriptParseError(source.SourcePath, root)
	}

	vocabulary, err := New().Vocabulary()
	if err != nil {
		return extractor.Contribution{}, fmt.Errorf("get TypeScript vocabulary: %w", err)
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

	analysis := analyzeTree(source, root, fileID, source.SourcePath, &facts)
	declarations := analysis.declarations
	appendLocalReferences(source, declarations, &facts)
	symbolReferences := collectSymbolReferences(source, declarations)
	symbolReferences = append(symbolReferences, collectCallReferences(source, declarations)...)
	exportedSurfaces := collectExportedSurfaces(source, analysis.exports, declarations)

	return extractor.NewContribution(vocabulary, extractor.ContributionInput{
		ProjectID:            source.ProjectID,
		SourcePath:           source.SourcePath,
		Metadata:             New().Metadata(),
		Facts:                facts,
		CatalogUnits:         extractor.CatalogUnitsForSource(source, facts),
		CatalogUnitsOmitted:  source.OmitCatalogUnits,
		UnresolvedReferences: analysis.moduleReferences,
		SymbolReferences:     symbolReferences,
		ExportedSurfaces:     exportedSurfaces,
		Diagnostics:          analysis.diagnostics,
	})
}

func parseTypeScript(parser *sitter.Parser, contents []byte) *sitter.Tree {
	tree := parser.Parse(contents, nil)
	if !tree.RootNode().HasError() {
		return tree
	}

	parsedContents, recovered := recoverTypeQueryCallArguments(contents)
	parsedContents, recoveredTypeOnlyStarReExport := recoverTypeOnlyStarReExports(parsedContents)
	recovered = recovered || recoveredTypeOnlyStarReExport
	if !recovered {
		return tree
	}
	recoveredTree := parser.Parse(parsedContents, nil)
	if recoveredTree.RootNode().HasError() {
		recoveredTree.Close()
		return tree
	}
	tree.Close()
	return recoveredTree
}

func recoverTypeQueryCallArguments(contents []byte) ([]byte, bool) {
	recovered := append([]byte(nil), contents...)
	found := false
	for _, match := range typeQueryCallPattern.FindAllIndex(contents, -1) {
		if !typeQueryCallIsTypeArgument(contents, match[0], match[1]) {
			continue
		}
		for index := match[0]; index < match[1]; index++ {
			if recovered[index] != '\n' && recovered[index] != '\r' {
				recovered[index] = ' '
			}
		}
		copy(recovered[match[0]:], "unknown")
		found = true
	}
	return recovered, found
}

func recoverTypeOnlyStarReExports(contents []byte) ([]byte, bool) {
	recovered := append([]byte(nil), contents...)
	found := false
	for _, match := range typeOnlyStarReExportPattern.FindAllSubmatchIndex(contents, -1) {
		for index := match[3]; index < match[4]; index++ {
			recovered[index] = ' '
		}
		found = true
	}
	return recovered, found
}

func typeQueryCallIsTypeArgument(contents []byte, start, end int) bool {
	before := start - 1
	for before >= 0 && (contents[before] == ' ' || contents[before] == '\t' || contents[before] == '\n' || contents[before] == '\r') {
		before--
	}
	after := end
	for after < len(contents) && (contents[after] == ' ' || contents[after] == '\t' || contents[after] == '\n' || contents[after] == '\r') {
		after++
	}
	return before >= 0 && contents[before] == '<' && after < len(contents) && contents[after] == '>'
}

func typeScriptParseError(sourcePath string, root *sitter.Node) error {
	node := firstParseErrorNode(root)
	if node == nil {
		return fmt.Errorf("parse TypeScript source %q: parser reported an unspecified error", sourcePath)
	}
	start := node.StartPosition()
	end := node.EndPosition()
	reason := node.Kind()
	if node.IsMissing() {
		reason = "missing " + reason
	}
	return fmt.Errorf("parse TypeScript source %q at %d:%d-%d:%d: %s", sourcePath, start.Row+1, start.Column+1, end.Row+1, end.Column+1, reason)
}

func firstParseErrorNode(node *sitter.Node) *sitter.Node {
	if node.IsError() || node.IsMissing() {
		return node
	}
	for index := uint(0); index < node.ChildCount(); index++ {
		if errorNode := firstParseErrorNode(node.Child(index)); errorNode != nil {
			return errorNode
		}
	}
	return nil
}

func (worker *Worker) parserForPath(path string) *sitter.Parser {
	if extractor.Extension(path) == ".tsx" {
		return worker.tsxParser
	}
	return worker.typescriptParser
}

type treeAnalysis struct {
	declarations     []declaration
	moduleReferences []extractor.UnresolvedReference
	diagnostics      []extractor.Diagnostic
	exports          []*sitter.Node
}

func analyzeTree(source extractor.Source, root *sitter.Node, fileID, parentQualifiedName string, facts *graph.Facts) treeAnalysis {
	analysis := treeAnalysis{}
	var visit func(*sitter.Node, string, string)
	visit = func(node *sitter.Node, parentID, parentName string) {
		if kind, found := moduleReferenceKind(source, node); found {
			specifiers, diagnostic, found := moduleSpecifiers(source, node)
			if diagnostic != "" {
				analysis.diagnostics = append(analysis.diagnostics, extractor.Diagnostic{Severity: extractor.DiagnosticWarning, Message: fmt.Sprintf("TypeScript dynamic module specifier in %q %s", source.SourcePath, diagnostic)})
			}
			if found {
				for _, specifier := range specifiers {
					analysis.moduleReferences = append(analysis.moduleReferences, extractor.UnresolvedReference{SourceID: fileID, Target: specifier.target, Kind: kind, Ambiguous: specifier.ambiguous, Bindings: moduleBindings(source, node)})
				}
			}
		}
		if node.Kind() == "export_statement" {
			analysis.exports = append(analysis.exports, node)
		}
		for childIndex := uint(0); childIndex < node.NamedChildCount(); childIndex++ {
			child := node.NamedChild(childIndex)
			kind, isDeclaration := declarationKind(child.Kind())
			name := child.ChildByFieldName("name")
			if !isDeclaration || name == nil {
				visit(child, parentID, parentName)
				continue
			}
			evidence := evidenceFor(source, child)
			declarationID := graph.NewNodeID(kind, evidence.Span)
			declarationName := name.Utf8Text(source.Contents)
			qualifiedName := qualifyName(source.SourcePath, parentName, declarationName)
			facts.Nodes = append(facts.Nodes, graph.Node{ID: declarationID, Kind: kind, Label: declarationName, QualifiedName: qualifiedName, Evidence: evidence})
			facts.Edges = append(facts.Edges, graph.Edge{SourceID: parentID, TargetID: declarationID, Relation: "defines", Evidence: evidence})
			analysis.declarations = append(analysis.declarations, declaration{id: declarationID, name: declarationName, qualifiedName: qualifiedName, node: child, nameStart: name.StartByte(), nameEnd: name.EndByte()})
			visit(child, declarationID, qualifiedName)
		}
	}
	visit(root, fileID, parentQualifiedName)
	return analysis
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
		switch declaration.node.Kind() {
		case "class_declaration":
			appendClassHeritageReferences(source, declaration, &references)
		case "interface_declaration":
			appendInterfaceHeritageReferences(source, declaration, &references)
		}
	}
	return references
}

func appendClassHeritageReferences(source extractor.Source, declaration declaration, references *[]extractor.SymbolReference) {
	for childIndex := uint(0); childIndex < declaration.node.NamedChildCount(); childIndex++ {
		heritage := declaration.node.NamedChild(childIndex)
		if heritage.Kind() != "class_heritage" {
			continue
		}
		for clauseIndex := uint(0); clauseIndex < heritage.NamedChildCount(); clauseIndex++ {
			clause := heritage.NamedChild(clauseIndex)
			relation, found := classHeritageRelation(clause.Kind())
			if !found {
				continue
			}
			appendSymbolReferences(source, clause, declaration.id, relation, references)
		}
	}
}

func appendInterfaceHeritageReferences(source extractor.Source, declaration declaration, references *[]extractor.SymbolReference) {
	for childIndex := uint(0); childIndex < declaration.node.NamedChildCount(); childIndex++ {
		clause := declaration.node.NamedChild(childIndex)
		if clause.Kind() == "extends_type_clause" {
			appendSymbolReferences(source, clause, declaration.id, ExtendsRelation, references)
		}
	}
}

func classHeritageRelation(kind string) (graph.RelationKind, bool) {
	switch kind {
	case "extends_clause":
		return ExtendsRelation, true
	case "implements_clause":
		return ImplementsRelation, true
	default:
		return "", false
	}
}

func appendSymbolReferences(source extractor.Source, node *sitter.Node, sourceID string, relation graph.RelationKind, references *[]extractor.SymbolReference) {
	for childIndex := uint(0); childIndex < node.NamedChildCount(); childIndex++ {
		child := node.NamedChild(childIndex)
		if child.Kind() == "type_arguments" {
			continue
		}
		if child.Kind() == "type_identifier" || child.Kind() == "identifier" {
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

func collectExportedSurfaces(source extractor.Source, exports []*sitter.Node, declarations []declaration) []extractor.ExportedSurface {
	surfaces := make([]extractor.ExportedSurface, 0)
	sort.SliceStable(declarations, func(left, right int) bool {
		return declarations[left].node.StartByte() < declarations[right].node.StartByte()
	})
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
	for _, exportedStatement := range exports {
		if exported := exportedStatement.ChildByFieldName("declaration"); exported != nil {
			defaultExport := strings.HasPrefix(strings.TrimSpace(exportedStatement.Utf8Text(source.Contents)), "export default")
			firstDeclaration := sort.Search(len(declarations), func(index int) bool {
				return declarations[index].node.StartByte() >= exported.StartByte()
			})
			for _, declaration := range declarations[firstDeclaration:] {
				if declaration.node.StartByte() > exported.EndByte() {
					break
				}
				if declaration.node.EndByte() <= exported.EndByte() {
					name := declaration.name
					if defaultExport {
						name = "default"
					}
					appendSurface(name, declaration)
				}
			}
		} else if exportedStatement.ChildByFieldName("source") == nil {
			for childIndex := uint(0); childIndex < exportedStatement.NamedChildCount(); childIndex++ {
				clause := exportedStatement.NamedChild(childIndex)
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
	return surfaces
}

func moduleReferenceKind(source extractor.Source, node *sitter.Node) (extractor.ModuleReferenceKind, bool) {
	switch node.Kind() {
	case "import_statement":
		return extractor.ModuleReferenceImport, true
	case "export_statement":
		// A declaration export (export function/const/class/...) has no source clause and re-exports nothing.
		if node.ChildByFieldName("source") == nil {
			return "", false
		}
		return extractor.ModuleReferenceReExport, true
	case "call_expression":
		function := node.ChildByFieldName("function")
		arguments := node.ChildByFieldName("arguments")
		if function == nil || arguments == nil || function.Utf8Text(source.Contents) != "import" || arguments.NamedChildCount() != 1 {
			return "", false
		}
		return extractor.ModuleReferenceImport, true
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
		if child.Kind() == "identifier" || child.Kind() == "type_identifier" {
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
	case "method_definition", "method_signature":
		return MethodNodeKind, true
	case "interface_declaration":
		return InterfaceNodeKind, true
	case "type_alias_declaration":
		return TypeAliasNodeKind, true
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
		Extractor:  "typescript@" + Version,
		Provenance: "static",
		Confidence: graph.ConfidenceExtracted,
	}
}
