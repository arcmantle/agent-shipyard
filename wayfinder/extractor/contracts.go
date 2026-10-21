package extractor

import (
	"context"
	"fmt"
	"path"
	"path/filepath"
	"strings"

	"agent-wayfinder/graph"
)

type Metadata struct {
	Name       string
	Version    string
	Extensions []string
}

type Source struct {
	ProjectID        string
	SourcePath       string
	Contents         []byte
	OmitCatalogUnits bool
}

type ResolverFileView struct {
	projectRoot string
	files       map[string][]byte
}

type ResolverTargetRequest struct {
	ProjectID  string
	Language   string
	SourcePath string
}

type ResolverTarget struct {
	ProjectID            string
	SourcePath           string
	Metadata             Metadata
	Nodes                []graph.Node
	UnresolvedReferences []UnresolvedReference
	SymbolReferences     []SymbolReference
	ExportedSurfaces     []ExportedSurface
	Diagnostics          []Diagnostic
}

type ResolverIndex interface {
	ResolverTarget(context.Context, ResolverTargetRequest) (ResolverTarget, bool, error)
	ResolverPackagePage(context.Context, ResolverPackagePageRequest) ([]ResolverTarget, error)
}

type ResolverPackagePageRequest struct {
	ProjectID       string
	Language        string
	PackagePath     string
	AfterSourcePath string
	Limit           int
}

type ResolverProjection struct {
	ProjectID            string
	SourcePath           string
	Metadata             Metadata
	Nodes                []graph.Node
	Edges                []graph.Edge
	UnresolvedReferences []UnresolvedReference
	SymbolReferences     []SymbolReference
	ExportedSurfaces     []ExportedSurface
	Dependencies         []Dependency
	Diagnostics          []Diagnostic
}

func NewResolverFileView(projectRoot string, files map[string][]byte) (ResolverFileView, error) {
	normalizedRoot, err := normalizeResolverPath(projectRoot)
	if err != nil {
		return ResolverFileView{}, fmt.Errorf("resolver file view project root: %w", err)
	}

	view := ResolverFileView{
		projectRoot: normalizedRoot,
		files:       make(map[string][]byte, len(files)),
	}
	for filePath, contents := range files {
		normalizedPath, err := normalizeResolverPath(filePath)
		if err != nil {
			return ResolverFileView{}, fmt.Errorf("resolver file view file %q: %w", filePath, err)
		}
		view.files[normalizedPath] = append([]byte(nil), contents...)
	}
	return view, nil
}

func (view ResolverFileView) ProjectRoot() string {
	return view.projectRoot
}

func (view ResolverFileView) File(filePath string) ([]byte, bool) {
	normalizedPath, err := normalizeResolverPath(filePath)
	if err != nil {
		return nil, false
	}
	contents, found := view.files[normalizedPath]
	return append([]byte(nil), contents...), found
}

func normalizeResolverPath(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", fmt.Errorf("must be a relative path inside the project")
	}
	normalized := path.Clean(trimmed)
	if path.IsAbs(normalized) || normalized == ".." || strings.HasPrefix(normalized, "../") {
		return "", fmt.Errorf("must be a relative path inside the project")
	}
	return normalized, nil
}

type Extractor interface {
	Metadata() Metadata
	Vocabulary() (graph.Vocabulary, error)
}

type ContributionInput struct {
	ProjectID            string
	SourcePath           string
	Metadata             Metadata
	Facts                graph.Facts
	CatalogUnits         []CatalogUnit
	CatalogUnitsOmitted  bool
	UnresolvedReferences []UnresolvedReference
	SymbolReferences     []SymbolReference
	ExportedSurfaces     []ExportedSurface
	Dependencies         []Dependency
	Diagnostics          []Diagnostic
}

type CatalogUnit struct {
	NodeID            string
	Name              string
	Kind              graph.NodeKind
	Owner             string
	Signature         string
	DeclarationSource string
	Comments          []string
	IdentifierTokens  []string
}

type ModuleReferenceKind string

const (
	ModuleReferenceImport   ModuleReferenceKind = "import"
	ModuleReferenceReExport ModuleReferenceKind = "re_export"
	ModuleReferenceRequire  ModuleReferenceKind = "require"
)

type UnresolvedReference struct {
	SourceID  string
	Target    string
	Kind      ModuleReferenceKind
	Ambiguous bool
	Bindings  []ModuleBinding
}

type ModuleBinding struct {
	ImportedName string
	ExportedName string
	LocalName    string
}

type SymbolReference struct {
	SourceID     string
	Target       string
	ReceiverType string
	Relation     graph.RelationKind
	Evidence     graph.FactEvidence
}

type ExportedSurface struct {
	NodeID string
	Name   string
}

type Dependency struct {
	SourcePath string
	TargetPath string
}

type DiagnosticSeverity string

const (
	DiagnosticError   DiagnosticSeverity = "error"
	DiagnosticWarning DiagnosticSeverity = "warning"
	DiagnosticInfo    DiagnosticSeverity = "info"
)

type Diagnostic struct {
	Severity DiagnosticSeverity
	Message  string
}

type Contribution struct {
	projectID            string
	sourcePath           string
	metadata             Metadata
	facts                graph.Facts
	catalogUnits         []CatalogUnit
	catalogUnitsOmitted  bool
	unresolvedReferences []UnresolvedReference
	symbolReferences     []SymbolReference
	exportedSurfaces     []ExportedSurface
	dependencies         []Dependency
	diagnostics          []Diagnostic
}

type GraphUpdate struct {
	contributions []Contribution
}

func NewGraphUpdate(contributions []Contribution) (GraphUpdate, error) {
	if len(contributions) == 0 {
		return GraphUpdate{}, fmt.Errorf("graph update has no contributions")
	}
	return GraphUpdate{contributions: append([]Contribution(nil), contributions...)}, nil
}

func (update GraphUpdate) Contributions() []Contribution {
	return append([]Contribution(nil), update.contributions...)
}

func NewContribution(vocabulary graph.Vocabulary, input ContributionInput) (Contribution, error) {
	if input.SourcePath == "" {
		return Contribution{}, fmt.Errorf("contribution source path is empty")
	}
	if err := input.Metadata.Validate(); err != nil {
		return Contribution{}, err
	}
	if err := vocabulary.Validate(input.Facts); err != nil {
		return Contribution{}, err
	}

	nodeIDs := make(map[string]struct{}, len(input.Facts.Nodes))
	for _, node := range input.Facts.Nodes {
		nodeIDs[node.ID] = struct{}{}
	}
	for _, unit := range input.CatalogUnits {
		if unit.NodeID == "" || unit.Name == "" || unit.Kind == "" || unit.Signature == "" {
			return Contribution{}, fmt.Errorf("catalog unit is incomplete")
		}
		if _, ok := nodeIDs[unit.NodeID]; !ok {
			return Contribution{}, fmt.Errorf("catalog unit node %q is not a local node", unit.NodeID)
		}
		for _, token := range unit.IdentifierTokens {
			if token == "" {
				return Contribution{}, fmt.Errorf("catalog unit identifier token is empty")
			}
		}
	}
	for _, reference := range input.UnresolvedReferences {
		if reference.SourceID == "" || reference.Target == "" || reference.Kind == "" {
			return Contribution{}, fmt.Errorf("unresolved reference is incomplete")
		}
		if _, ok := nodeIDs[reference.SourceID]; !ok {
			return Contribution{}, fmt.Errorf("unresolved reference source %q is not a local node", reference.SourceID)
		}
		if reference.Kind != ModuleReferenceImport && reference.Kind != ModuleReferenceReExport && reference.Kind != ModuleReferenceRequire {
			return Contribution{}, fmt.Errorf("unresolved reference kind %q is unsupported", reference.Kind)
		}
		for _, binding := range reference.Bindings {
			if binding.ImportedName == "" {
				return Contribution{}, fmt.Errorf("module binding imported name is empty")
			}
		}
	}
	for _, reference := range input.SymbolReferences {
		if reference.SourceID == "" || reference.Target == "" || reference.Relation == "" {
			return Contribution{}, fmt.Errorf("symbol reference is incomplete")
		}
		if _, ok := nodeIDs[reference.SourceID]; !ok {
			return Contribution{}, fmt.Errorf("symbol reference source %q is not a local node", reference.SourceID)
		}
		if err := validateReferenceEvidence(reference.Evidence); err != nil {
			return Contribution{}, fmt.Errorf("symbol reference evidence: %w", err)
		}
	}
	for _, surface := range input.ExportedSurfaces {
		if surface.NodeID == "" || surface.Name == "" {
			return Contribution{}, fmt.Errorf("exported surface is incomplete")
		}
		if _, ok := nodeIDs[surface.NodeID]; !ok {
			return Contribution{}, fmt.Errorf("exported surface node %q is not a local node", surface.NodeID)
		}
	}
	for _, dependency := range input.Dependencies {
		if dependency.SourcePath == "" || dependency.TargetPath == "" {
			return Contribution{}, fmt.Errorf("dependency is incomplete")
		}
	}
	for _, diagnostic := range input.Diagnostics {
		if diagnostic.Message == "" {
			return Contribution{}, fmt.Errorf("diagnostic message is empty")
		}
		if diagnostic.Severity != DiagnosticError && diagnostic.Severity != DiagnosticWarning && diagnostic.Severity != DiagnosticInfo {
			return Contribution{}, fmt.Errorf("diagnostic severity %q is unsupported", diagnostic.Severity)
		}
	}

	return Contribution{
		projectID:            input.ProjectID,
		sourcePath:           input.SourcePath,
		metadata:             copyMetadata(input.Metadata),
		facts:                copyFacts(input.Facts),
		catalogUnits:         copyCatalogUnits(input.CatalogUnits),
		catalogUnitsOmitted:  input.CatalogUnitsOmitted,
		unresolvedReferences: copyUnresolvedReferences(input.UnresolvedReferences),
		symbolReferences:     append([]SymbolReference(nil), input.SymbolReferences...),
		exportedSurfaces:     append([]ExportedSurface(nil), input.ExportedSurfaces...),
		dependencies:         append([]Dependency(nil), input.Dependencies...),
		diagnostics:          append([]Diagnostic(nil), input.Diagnostics...),
	}, nil
}

func (contribution Contribution) ProjectID() string {
	return contribution.projectID
}

func (contribution Contribution) SourcePath() string {
	return contribution.sourcePath
}

func (contribution Contribution) Metadata() Metadata {
	return copyMetadata(contribution.metadata)
}

func (contribution Contribution) Facts() graph.Facts {
	return copyFacts(contribution.facts)
}

func (contribution Contribution) CatalogUnits() []CatalogUnit {
	return copyCatalogUnits(contribution.catalogUnits)
}

func (contribution Contribution) CatalogUnitsOmitted() bool {
	return contribution.catalogUnitsOmitted
}

func (contribution Contribution) UnresolvedReferences() []UnresolvedReference {
	return copyUnresolvedReferences(contribution.unresolvedReferences)
}

func (contribution Contribution) SymbolReferences() []SymbolReference {
	return append([]SymbolReference(nil), contribution.symbolReferences...)
}

func (contribution Contribution) ExportedSurfaces() []ExportedSurface {
	return append([]ExportedSurface(nil), contribution.exportedSurfaces...)
}

func (contribution Contribution) Dependencies() []Dependency {
	return append([]Dependency(nil), contribution.dependencies...)
}

func (contribution Contribution) WithDependencies(dependencies []Dependency) (Contribution, error) {
	for _, dependency := range dependencies {
		if dependency.SourcePath != contribution.sourcePath || dependency.TargetPath == "" {
			return Contribution{}, fmt.Errorf("dependency must have source %q and a target path", contribution.sourcePath)
		}
	}
	contribution.dependencies = append([]Dependency(nil), dependencies...)
	return contribution, nil
}

func (contribution Contribution) Diagnostics() []Diagnostic {
	return append([]Diagnostic(nil), contribution.diagnostics...)
}

func copyMetadata(metadata Metadata) Metadata {
	metadata.Extensions = append([]string(nil), metadata.Extensions...)
	return metadata
}

func copyFacts(facts graph.Facts) graph.Facts {
	return graph.Facts{
		Nodes: append([]graph.Node(nil), facts.Nodes...),
		Edges: append([]graph.Edge(nil), facts.Edges...),
	}
}

func copyCatalogUnits(units []CatalogUnit) []CatalogUnit {
	copied := make([]CatalogUnit, len(units))
	for index, unit := range units {
		copied[index] = unit
		copied[index].Comments = append([]string(nil), unit.Comments...)
		copied[index].IdentifierTokens = append([]string(nil), unit.IdentifierTokens...)
	}
	return copied
}

func copyUnresolvedReferences(references []UnresolvedReference) []UnresolvedReference {
	copied := make([]UnresolvedReference, len(references))
	for index, reference := range references {
		copied[index] = reference
		copied[index].Bindings = append([]ModuleBinding(nil), reference.Bindings...)
	}
	return copied
}

func validateReferenceEvidence(evidence graph.FactEvidence) error {
	if evidence.Span.Path == "" || evidence.Span.StartLine < 1 || evidence.Span.StartColumn < 1 || evidence.Span.EndLine < 1 || evidence.Span.EndColumn < 1 || evidence.FileHash == "" || evidence.Extractor == "" || evidence.Provenance == "" {
		return fmt.Errorf("is incomplete")
	}
	if evidence.Span.StartLine > evidence.Span.EndLine || evidence.Span.StartLine == evidence.Span.EndLine && evidence.Span.StartColumn > evidence.Span.EndColumn {
		return fmt.Errorf("has an invalid span")
	}
	if evidence.Confidence != graph.ConfidenceExtracted && evidence.Confidence != graph.ConfidenceInferred && evidence.Confidence != graph.ConfidenceAmbiguous {
		return fmt.Errorf("has unsupported confidence %q", evidence.Confidence)
	}
	return nil
}

func (metadata Metadata) Validate() error {
	if metadata.Name == "" {
		return fmt.Errorf("extractor name is empty")
	}
	if metadata.Version == "" {
		return fmt.Errorf("extractor %q version is empty", metadata.Name)
	}
	if len(metadata.Extensions) == 0 {
		return fmt.Errorf("extractor %q has no supported extensions", metadata.Name)
	}

	extensions := make(map[string]struct{}, len(metadata.Extensions))
	for _, extension := range metadata.Extensions {
		normalized := normalizeExtension(extension)
		if normalized == "" {
			return fmt.Errorf("extractor %q has an empty extension", metadata.Name)
		}
		if _, exists := extensions[normalized]; exists {
			return fmt.Errorf("extractor %q registers extension %q more than once", metadata.Name, normalized)
		}
		extensions[normalized] = struct{}{}
	}

	return nil
}

func NormalizeExtension(extension string) string {
	return normalizeExtension(extension)
}

func normalizeExtension(extension string) string {
	normalized := strings.ToLower(strings.TrimSpace(extension))
	if normalized == "" {
		return ""
	}
	if !strings.HasPrefix(normalized, ".") {
		normalized = "." + normalized
	}
	return normalized
}

func Extension(path string) string {
	return normalizeExtension(filepath.Ext(path))
}
