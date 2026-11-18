package csharp

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
)

// ImportsFromRelation links an import directive to the namespace or type it
// names within the same project.
const ImportsFromRelation graph.RelationKind = "csharp:imports_from"

const resolverPackagePageSize = 128

// Resolution holds the cross-source facts C# resolution produces.
type Resolution struct {
	facts       graph.Facts
	diagnostics []extractor.Diagnostic
}

func (resolution Resolution) Facts() graph.Facts {
	return graph.Facts{
		Nodes: append([]graph.Node(nil), resolution.facts.Nodes...),
		Edges: append([]graph.Edge(nil), resolution.facts.Edges...),
	}
}

func (resolution Resolution) Diagnostics() []extractor.Diagnostic {
	return append([]extractor.Diagnostic(nil), resolution.diagnostics...)
}

// ResolverVocabulary describes the facts C# resolution adds to extracted nodes.
func ResolverVocabulary() (graph.Vocabulary, error) {
	sources := []graph.NodeKind{ImportNodeKind, TypeAliasNodeKind}
	// A file-to-file link records the dependency incremental indexing follows.
	targets := []graph.NodeKind{NamespaceNodeKind, ClassNodeKind, StructNodeKind, InterfaceNodeKind, RecordNodeKind, EnumNodeKind, DelegateNodeKind}
	var endpoints []graph.EndpointRule
	for _, source := range sources {
		for _, target := range targets {
			endpoints = append(endpoints, graph.EndpointRule{Source: source, Target: target})
		}
	}
	endpoints = append(endpoints, graph.EndpointRule{Source: "file", Target: "file"})
	return graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: append(append([]graph.NodeKind{"file"}, sources...), targets...),
		Relations: []graph.RelationDefinition{{Kind: ImportsFromRelation, Endpoints: endpoints}},
	})
}

// Resolve links the import directives of one project's contributions.
func Resolve(contributions []extractor.Contribution) (Resolution, error) {
	if err := checkContributions(contributions); err != nil {
		return Resolution{}, err
	}
	declarations := newDeclarations()
	for _, contribution := range contributions {
		declarations.add(contribution.Facts().Nodes)
	}
	return resolveWith(contributions, declarations)
}

// ResolvePage links the import directives of a page of one project's
// contributions against every declaration the resolver index holds for the
// project.
func ResolvePage(ctx context.Context, contributions []extractor.Contribution, projectID string, index extractor.ResolverIndex) (Resolution, error) {
	if projectID == "" || index == nil {
		return Resolution{}, fmt.Errorf("resolve C# page: project and resolver index are required")
	}
	if err := ctx.Err(); err != nil {
		return Resolution{}, err
	}
	if err := checkContributions(contributions); err != nil {
		return Resolution{}, err
	}
	if !hasImports(contributions) {
		return Resolution{}, nil
	}
	index = extractor.NewPageResolverIndex(index)
	declarations := newDeclarations()
	for _, contribution := range contributions {
		declarations.add(contribution.Facts().Nodes)
	}
	after := ""
	for {
		page, err := index.ResolverPackagePage(ctx, extractor.ResolverPackagePageRequest{
			ProjectID:       projectID,
			Language:        "csharp",
			PackagePath:     ".",
			Recursive:       true,
			AfterSourcePath: after,
			Limit:           resolverPackagePageSize,
		})
		if err != nil {
			return Resolution{}, fmt.Errorf("read C# resolver project %q: %w", projectID, err)
		}
		if len(page) == 0 {
			break
		}
		for _, target := range page {
			after = target.SourcePath
			declarations.add(target.Nodes)
		}
	}
	return resolveWith(contributions, declarations)
}

func checkContributions(contributions []extractor.Contribution) error {
	for _, contribution := range contributions {
		if contribution.Metadata().Name != "csharp" {
			return fmt.Errorf("resolve C#: contribution %q belongs to extractor %q", contribution.SourcePath(), contribution.Metadata().Name)
		}
	}
	return nil
}

func hasImports(contributions []extractor.Contribution) bool {
	for _, contribution := range contributions {
		if len(contribution.UnresolvedReferences()) > 0 {
			return true
		}
	}
	return false
}

// declarations indexes a project's namespaces and types by full name. A
// namespace is one logical target however many files declare it.
type declarations struct {
	seen       map[string]struct{}
	namespaces map[string][]graph.Node
	types      map[string][]graph.Node
	files      map[string]graph.Node
}

func newDeclarations() *declarations {
	return &declarations{seen: map[string]struct{}{}, namespaces: map[string][]graph.Node{}, types: map[string][]graph.Node{}, files: map[string]graph.Node{}}
}

func (index *declarations) add(nodes []graph.Node) {
	for _, node := range nodes {
		if _, duplicate := index.seen[node.ID]; duplicate {
			continue
		}
		switch node.Kind {
		case "file":
			index.files[node.QualifiedName] = node
			continue
		case NamespaceNodeKind:
			index.namespaces[fullName(node)] = append(index.namespaces[fullName(node)], node)
		case ClassNodeKind, StructNodeKind, InterfaceNodeKind, RecordNodeKind, EnumNodeKind, DelegateNodeKind:
			index.types[fullName(node)] = append(index.types[fullName(node)], node)
		default:
			continue
		}
		index.seen[node.ID] = struct{}{}
	}
}

// fullName is the dotted name a declaration has in C#, without its source path.
func fullName(node graph.Node) string {
	return strings.TrimPrefix(node.QualifiedName, node.Evidence.Span.Path+"::")
}

func resolveWith(contributions []extractor.Contribution, declarations *declarations) (Resolution, error) {
	resolution := Resolution{}
	files := map[string]graph.Node{}
	links := map[[2]string]graph.FactEvidence{}
	for _, contribution := range contributions {
		facts := contribution.Facts()
		for _, node := range facts.Nodes {
			if node.Kind == "file" {
				files[contribution.SourcePath()] = node
			}
		}
		nodes := make(map[string]graph.Node, len(facts.Nodes))
		for _, node := range facts.Nodes {
			nodes[node.ID] = node
		}
		owners := make(map[string]string, len(facts.Edges))
		for _, edge := range facts.Edges {
			if edge.Relation == "defines" {
				owners[edge.TargetID] = edge.SourceID
			}
		}
		for _, reference := range contribution.UnresolvedReferences() {
			if reference.Kind != extractor.ModuleReferenceImport {
				continue
			}
			source, found := nodes[reference.SourceID]
			if !found {
				continue
			}
			scopes := enclosingNamespaces(nodes[owners[source.ID]])
			targets, ambiguous := importTargets(reference, scopes, declarations)
			if ambiguous {
				resolution.diagnostics = append(resolution.diagnostics, extractor.Diagnostic{Severity: extractor.DiagnosticWarning, Message: fmt.Sprintf("C# import %q from %q is ambiguous", reference.Target, contribution.SourcePath())})
			}
			for _, target := range targets {
				resolution.facts.Edges = append(resolution.facts.Edges, graph.Edge{SourceID: source.ID, TargetID: target.ID, Relation: ImportsFromRelation, Evidence: source.Evidence})
				resolution.facts.Nodes = append(resolution.facts.Nodes, source, target)
				targetFile, found := declarations.files[target.Evidence.Span.Path]
				if sourceFile, ok := files[contribution.SourcePath()]; ok && found && targetFile.ID != sourceFile.ID {
					links[[2]string{sourceFile.ID, targetFile.ID}] = sourceFile.Evidence
					resolution.facts.Nodes = append(resolution.facts.Nodes, sourceFile, targetFile)
				}
			}
		}
	}
	for link, evidence := range links {
		resolution.facts.Edges = append(resolution.facts.Edges, graph.Edge{SourceID: link[0], TargetID: link[1], Relation: ImportsFromRelation, Evidence: evidence})
	}
	sort.Slice(resolution.facts.Edges, func(left, right int) bool {
		if resolution.facts.Edges[left].SourceID != resolution.facts.Edges[right].SourceID {
			return resolution.facts.Edges[left].SourceID < resolution.facts.Edges[right].SourceID
		}
		return resolution.facts.Edges[left].TargetID < resolution.facts.Edges[right].TargetID
	})
	resolution.facts.Nodes = uniqueNodes(resolution.facts.Nodes)
	vocabulary, err := ResolverVocabulary()
	if err != nil {
		return Resolution{}, fmt.Errorf("get C# resolver vocabulary: %w", err)
	}
	if err := vocabulary.Validate(resolution.facts); err != nil {
		return Resolution{}, fmt.Errorf("validate C# resolution: %w", err)
	}
	return resolution, nil
}

// enclosingNamespaces lists the namespace names a directive's relative target
// is tried against, innermost first, ending with the global scope "". A
// directive outside any namespace, including a global one, has only the global scope.
func enclosingNamespaces(owner graph.Node) []string {
	scopes := []string{}
	if owner.Kind == NamespaceNodeKind {
		for name := fullName(owner); name != ""; {
			scopes = append(scopes, name)
			cut := strings.LastIndex(name, ".")
			if cut < 0 {
				break
			}
			name = name[:cut]
		}
	}
	return append(scopes, "")
}

// importTargets resolves a directive in the innermost scope that declares its
// target. A namespace import names every declaration of the namespace; a static
// or alias import names a type only when exactly one declares it.
func importTargets(reference extractor.UnresolvedReference, scopes []string, declarations *declarations) ([]graph.Node, bool) {
	static := len(reference.Bindings) == 1 && reference.Bindings[0].ExportedName == StaticBinding
	alias := len(reference.Bindings) == 1 && reference.Bindings[0].LocalName != ""
	for _, scope := range scopes {
		name := reference.Target
		if scope != "" {
			name = scope + "." + name
		}
		types := declarations.types[name]
		if static || alias {
			if len(types) > 1 {
				return nil, true
			}
			if len(types) == 1 && (alias || static && types[0].Kind != DelegateNodeKind) {
				return types, false
			}
		}
		if static {
			continue
		}
		if namespaces := declarations.namespaces[name]; len(namespaces) > 0 {
			return namespaces, false
		}
	}
	return nil, false
}

func uniqueNodes(nodes []graph.Node) []graph.Node {
	seen := make(map[string]struct{}, len(nodes))
	unique := make([]graph.Node, 0, len(nodes))
	for _, node := range nodes {
		if _, duplicate := seen[node.ID]; duplicate {
			continue
		}
		seen[node.ID] = struct{}{}
		unique = append(unique, node)
	}
	sort.Slice(unique, func(left, right int) bool { return unique[left].ID < unique[right].ID })
	return unique
}
