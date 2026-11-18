package csharp

import (
	"context"
	"fmt"
	"strings"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
)

const (
	// ReferencesRelation links a declaration to a declared type it names.
	ReferencesRelation graph.RelationKind = "references"
	// CallsRelation links a declaration to a method it invokes.
	CallsRelation graph.RelationKind = "csharp:calls"
)

const resolverPageLimit = 128

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

// Resolve links the symbol references and calls of every contribution to
// declarations owned by the same project. Targets in other projects are never
// considered.
func Resolve(contributions []extractor.Contribution) (Resolution, error) {
	if err := checkContributions(contributions); err != nil {
		return Resolution{}, err
	}
	symbols := make(map[string]*projectSymbols)
	for _, contribution := range contributions {
		project := symbols[contribution.ProjectID()]
		if project == nil {
			project = newProjectSymbols()
			symbols[contribution.ProjectID()] = project
		}
		project.addNodes(contribution.Facts().Nodes)
	}
	resolution := Resolution{}
	for _, contribution := range contributions {
		resolveContribution(contribution, symbols[contribution.ProjectID()], &resolution)
	}
	return resolution, nil
}

// ResolvePage resolves one page of contributions against every declaration in
// the page's project, read from the resolver index.
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
	resolvable := false
	for _, contribution := range contributions {
		if contribution.ProjectID() != projectID {
			return Resolution{}, fmt.Errorf("resolve C# page: contribution %q belongs to project %q, not %q", contribution.SourcePath(), contribution.ProjectID(), projectID)
		}
		resolvable = resolvable || len(contribution.SymbolReferences()) > 0
	}
	if !resolvable {
		return Resolution{}, nil
	}

	index = extractor.NewPageResolverIndex(index)
	project := newProjectSymbols()
	for _, contribution := range contributions {
		project.addNodes(contribution.Facts().Nodes)
	}
	after := ""
	for {
		targets, err := index.ResolverPackagePage(ctx, extractor.ResolverPackagePageRequest{
			ProjectID:       projectID,
			Language:        "csharp",
			PackagePath:     ".",
			AfterSourcePath: after,
			Limit:           resolverPageLimit,
			Recursive:       true,
		})
		if err != nil {
			return Resolution{}, fmt.Errorf("read C# project %q: %w", projectID, err)
		}
		if len(targets) == 0 {
			break
		}
		for _, target := range targets {
			project.addNodes(target.Nodes)
			after = target.SourcePath
		}
	}
	resolution := Resolution{}
	for _, contribution := range contributions {
		resolveContribution(contribution, project, &resolution)
	}
	return resolution, nil
}

func checkContributions(contributions []extractor.Contribution) error {
	for _, contribution := range contributions {
		if contribution.Metadata().Name != "csharp" {
			return fmt.Errorf("resolve C#: contribution %q belongs to extractor %q", contribution.SourcePath(), contribution.Metadata().Name)
		}
	}
	return nil
}

// projectSymbols indexes one project's types and methods by their C# name,
// which is the qualified name without its source-path prefix.
type projectSymbols struct {
	seen    map[string]struct{}
	types   map[string][]graph.Node
	methods map[string][]graph.Node
}

func newProjectSymbols() *projectSymbols {
	return &projectSymbols{
		seen:    make(map[string]struct{}),
		types:   make(map[string][]graph.Node),
		methods: make(map[string][]graph.Node),
	}
}

func (symbols *projectSymbols) addNodes(nodes []graph.Node) {
	for _, node := range nodes {
		if _, found := symbols.seen[node.ID]; found {
			continue
		}
		symbols.seen[node.ID] = struct{}{}
		switch node.Kind {
		case ClassNodeKind, StructNodeKind, InterfaceNodeKind, RecordNodeKind, EnumNodeKind, DelegateNodeKind:
			symbols.types[csharpName(node)] = append(symbols.types[csharpName(node)], node)
		case MethodNodeKind:
			symbols.methods[csharpName(node)] = append(symbols.methods[csharpName(node)], node)
		}
	}
}

// csharpName drops the source-path prefix of a qualified name.
func csharpName(node graph.Node) string {
	if position := strings.LastIndex(node.QualifiedName, "::"); position >= 0 {
		return node.QualifiedName[position+2:]
	}
	return node.QualifiedName
}

func resolveContribution(contribution extractor.Contribution, symbols *projectSymbols, resolution *Resolution) {
	references := contribution.SymbolReferences()
	if len(references) == 0 {
		return
	}
	sources := make(map[string]graph.Node)
	for _, node := range contribution.Facts().Nodes {
		sources[node.ID] = node
	}
	for _, reference := range references {
		source, found := sources[reference.SourceID]
		if !found {
			continue
		}
		scopes := lookupScopes(csharpName(source))
		var matches []graph.Node
		switch reference.Relation {
		case ReferencesRelation:
			matches, _ = lookupType(symbols, scopes, reference.Target)
		case CallsRelation:
			matches = lookupMethod(symbols, scopes, reference.Target)
		default:
			continue
		}
		if len(matches) > 1 {
			resolution.diagnostics = append(resolution.diagnostics, extractor.Diagnostic{
				Severity: extractor.DiagnosticWarning,
				Message:  fmt.Sprintf("C# %s %q from %q is ambiguous", relationLabel(reference.Relation), reference.Target, contribution.SourcePath()),
			})
			continue
		}
		if len(matches) == 1 {
			resolution.facts.Edges = append(resolution.facts.Edges, graph.Edge{
				SourceID: reference.SourceID,
				TargetID: matches[0].ID,
				Relation: reference.Relation,
				Evidence: reference.Evidence,
			})
		}
	}
}

func relationLabel(relation graph.RelationKind) string {
	if relation == CallsRelation {
		return "call"
	}
	return "reference"
}

// lookupScopes lists the enclosing C# scopes of a declaration from innermost to
// outermost, ending with the global scope.
func lookupScopes(name string) []string {
	scopes := []string{name}
	for {
		position := strings.LastIndex(name, ".")
		if position < 0 {
			return append(scopes, "")
		}
		name = name[:position]
		scopes = append(scopes, name)
	}
}

func scoped(scope, name string) string {
	if scope == "" {
		return name
	}
	return scope + "." + name
}

// lookupType finds the declarations a type name denotes. The innermost scope
// that declares the name wins; several declarations in that scope are ambiguous.
func lookupType(symbols *projectSymbols, scopes []string, name string) ([]graph.Node, string) {
	for _, scope := range scopes {
		full := scoped(scope, name)
		if matches := symbols.types[full]; len(matches) > 0 {
			return matches, full
		}
	}
	return nil, ""
}

// lookupMethod resolves a call target written as `Method` (a method of an
// enclosing type) or `Receiver.Method` (a method of the named type).
func lookupMethod(symbols *projectSymbols, scopes []string, target string) []graph.Node {
	if position := strings.LastIndex(target, "."); position >= 0 {
		matches, full := lookupType(symbols, scopes, target[:position])
		if len(matches) != 1 {
			return matches
		}
		return symbols.methods[full+"."+target[position+1:]]
	}
	for _, scope := range scopes {
		if len(symbols.types[scope]) == 0 {
			continue
		}
		if matches := symbols.methods[scope+"."+target]; len(matches) > 0 {
			return matches
		}
	}
	return nil
}
