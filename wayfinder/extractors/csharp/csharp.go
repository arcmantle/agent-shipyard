package csharp

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"

	sitter "github.com/tree-sitter/go-tree-sitter"
	csharp_grammar "github.com/tree-sitter/tree-sitter-c-sharp/bindings/go"
)

const Version = "v0"

const ClassNodeKind graph.NodeKind = "csharp:class"

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
	return extractor.NewLanguageVocabulary("csharp", []graph.NodeKind{ClassNodeKind})
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
	collectClasses(source, root, fileID, &facts)

	return extractor.NewContribution(vocabulary, extractor.ContributionInput{
		ProjectID:           source.ProjectID,
		SourcePath:          source.SourcePath,
		Metadata:            New().Metadata(),
		Facts:               facts,
		CatalogUnits:        extractor.CatalogUnitsForSource(source, facts),
		CatalogUnitsOmitted: source.OmitCatalogUnits,
	})
}

// collectClasses records top-level and namespace-level classes. Later issues extend
// the declaration set and qualify names by namespace and nesting.
func collectClasses(source extractor.Source, node *sitter.Node, fileID string, facts *graph.Facts) {
	for childIndex := uint(0); childIndex < node.NamedChildCount(); childIndex++ {
		child := node.NamedChild(childIndex)
		switch child.Kind() {
		case "namespace_declaration", "file_scoped_namespace_declaration", "declaration_list":
			collectClasses(source, child, fileID, facts)
		case "class_declaration":
			name := child.ChildByFieldName("name")
			if name == nil {
				continue
			}
			evidence := evidenceFor(source, child)
			classID := graph.NewNodeID(ClassNodeKind, evidence.Span)
			className := name.Utf8Text(source.Contents)
			facts.Nodes = append(facts.Nodes, graph.Node{
				ID:            classID,
				Kind:          ClassNodeKind,
				Label:         className,
				QualifiedName: source.SourcePath + "::" + className,
				Evidence:      evidence,
			})
			facts.Edges = append(facts.Edges, graph.Edge{
				SourceID: fileID,
				TargetID: classID,
				Relation: "defines",
				Evidence: evidence,
			})
		}
	}
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
