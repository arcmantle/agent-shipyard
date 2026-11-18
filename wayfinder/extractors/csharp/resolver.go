package csharp

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
)

const (
	// ImportsFromRelation links an import directive to the namespace or type it
	// names.
	ImportsFromRelation graph.RelationKind = "csharp:imports_from"
	// ReferencesRelation links a declaration to a declared type it names.
	ReferencesRelation graph.RelationKind = "references"
	// CallsRelation links a declaration to a method it invokes.
	CallsRelation graph.RelationKind = "csharp:calls"
	// ExtendsRelation links a class to its base class, a record to its base
	// record, and an interface to an interface it inherits.
	ExtendsRelation graph.RelationKind = "csharp:extends"
	// ImplementsRelation links a class, struct, or record to an interface it
	// implements.
	ImplementsRelation graph.RelationKind = "csharp:implements"
	// BaseTypeRelation is an extracted base-list entry of a class or record whose
	// relation depends on what the name resolves to. Resolution replaces it with
	// ExtendsRelation or ImplementsRelation and never publishes it.
	BaseTypeRelation graph.RelationKind = "csharp:base_type"
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

// ResolverVocabulary describes the import and type-relationship facts C#
// resolution adds to extracted nodes.
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
		Relations: []graph.RelationDefinition{
			{Kind: ImportsFromRelation, Endpoints: endpoints},
			{Kind: ExtendsRelation, Endpoints: []graph.EndpointRule{
				{Source: ClassNodeKind, Target: ClassNodeKind},
				{Source: RecordNodeKind, Target: RecordNodeKind},
				{Source: InterfaceNodeKind, Target: InterfaceNodeKind},
			}},
			{Kind: ImplementsRelation, Endpoints: []graph.EndpointRule{
				{Source: ClassNodeKind, Target: InterfaceNodeKind},
				{Source: StructNodeKind, Target: InterfaceNodeKind},
				{Source: RecordNodeKind, Target: InterfaceNodeKind},
			}},
		},
	})
}

// Resolve links the imports, symbol references, and calls of one project's
// contributions. A target is looked up in the project itself first and, when
// the project does not declare it, in the contributions of the projects it
// reaches through local project references. Nothing else is searched.
func Resolve(contributions []extractor.Contribution, referenced []extractor.Contribution) (Resolution, error) {
	if err := checkContributions(contributions, referenced); err != nil {
		return Resolution{}, err
	}
	visible := newVisibleSymbols()
	visible.own.addNodes(contributionNodes(contributions))
	visible.referenced.addNodes(contributionNodes(referenced))
	return resolveWith(contributions, visible)
}

// ResolvePage resolves one page of a project's contributions against every
// declaration of the project and of the referenced projects, read from the
// resolver index.
func ResolvePage(ctx context.Context, contributions []extractor.Contribution, projectID string, referencedProjectIDs []string, index extractor.ResolverIndex) (Resolution, error) {
	if projectID == "" || index == nil {
		return Resolution{}, fmt.Errorf("resolve C# page: project and resolver index are required")
	}
	if err := ctx.Err(); err != nil {
		return Resolution{}, err
	}
	if err := checkContributions(contributions, nil); err != nil {
		return Resolution{}, err
	}
	resolvable := false
	for _, contribution := range contributions {
		if contribution.ProjectID() != projectID {
			return Resolution{}, fmt.Errorf("resolve C# page: contribution %q belongs to project %q, not %q", contribution.SourcePath(), contribution.ProjectID(), projectID)
		}
		resolvable = resolvable || len(contribution.SymbolReferences()) > 0 || len(contribution.UnresolvedReferences()) > 0
	}
	if !resolvable {
		return Resolution{}, nil
	}

	index = extractor.NewPageResolverIndex(index)
	visible := newVisibleSymbols()
	visible.own.addNodes(contributionNodes(contributions))
	if err := readProject(ctx, index, projectID, visible.own); err != nil {
		return Resolution{}, err
	}
	for _, referencedID := range uniqueProjectIDs(referencedProjectIDs, projectID) {
		if err := readProject(ctx, index, referencedID, visible.referenced); err != nil {
			return Resolution{}, err
		}
	}
	return resolveWith(contributions, visible)
}

// uniqueProjectIDs drops repeated project IDs and the project itself, so a
// project that references itself or is listed twice is read once.
func uniqueProjectIDs(projectIDs []string, self string) []string {
	seen := map[string]struct{}{self: {}}
	unique := make([]string, 0, len(projectIDs))
	for _, projectID := range projectIDs {
		if _, duplicate := seen[projectID]; duplicate {
			continue
		}
		seen[projectID] = struct{}{}
		unique = append(unique, projectID)
	}
	return unique
}

func readProject(ctx context.Context, index extractor.ResolverIndex, projectID string, symbols *projectSymbols) error {
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
			return fmt.Errorf("read C# project %q: %w", projectID, err)
		}
		if len(targets) == 0 {
			return nil
		}
		for _, target := range targets {
			symbols.addNodes(target.Nodes)
			after = target.SourcePath
		}
	}
}

// checkContributions requires C# contributions of one project and referenced
// contributions of other projects.
func checkContributions(contributions, referenced []extractor.Contribution) error {
	projectID := ""
	for index, contribution := range contributions {
		if contribution.Metadata().Name != "csharp" {
			return fmt.Errorf("resolve C#: contribution %q belongs to extractor %q", contribution.SourcePath(), contribution.Metadata().Name)
		}
		if index == 0 {
			projectID = contribution.ProjectID()
		} else if contribution.ProjectID() != projectID {
			return fmt.Errorf("resolve C#: contribution %q belongs to project %q, not %q", contribution.SourcePath(), contribution.ProjectID(), projectID)
		}
	}
	for _, contribution := range referenced {
		if contribution.Metadata().Name != "csharp" {
			return fmt.Errorf("resolve C#: contribution %q belongs to extractor %q", contribution.SourcePath(), contribution.Metadata().Name)
		}
		if len(contributions) > 0 && contribution.ProjectID() == projectID {
			return fmt.Errorf("resolve C#: referenced contribution %q belongs to the resolved project %q", contribution.SourcePath(), projectID)
		}
	}
	return nil
}

func contributionNodes(contributions []extractor.Contribution) []graph.Node {
	var nodes []graph.Node
	for _, contribution := range contributions {
		nodes = append(nodes, contribution.Facts().Nodes...)
	}
	return nodes
}

// projectSymbols indexes the namespaces, types, and methods of the projects it
// holds by their C# name, which is the qualified name without its source-path
// prefix. A namespace is one logical target however many files declare it.
type projectSymbols struct {
	seen       map[string]struct{}
	namespaces map[string][]graph.Node
	types      map[string][]graph.Node
	methods    map[string][]graph.Node
	files      map[string]graph.Node
}

func newProjectSymbols() *projectSymbols {
	return &projectSymbols{
		seen:       make(map[string]struct{}),
		namespaces: make(map[string][]graph.Node),
		types:      make(map[string][]graph.Node),
		methods:    make(map[string][]graph.Node),
		files:      make(map[string]graph.Node),
	}
}

func (symbols *projectSymbols) addNodes(nodes []graph.Node) {
	for _, node := range nodes {
		if _, duplicate := symbols.seen[node.ID]; duplicate {
			continue
		}
		switch node.Kind {
		case "file":
			symbols.files[node.QualifiedName] = node
		case NamespaceNodeKind:
			symbols.namespaces[fullName(node)] = append(symbols.namespaces[fullName(node)], node)
		case ClassNodeKind, StructNodeKind, InterfaceNodeKind, RecordNodeKind, EnumNodeKind, DelegateNodeKind:
			symbols.types[fullName(node)] = append(symbols.types[fullName(node)], node)
		case MethodNodeKind:
			symbols.methods[fullName(node)] = append(symbols.methods[fullName(node)], node)
		default:
			continue
		}
		symbols.seen[node.ID] = struct{}{}
	}
}

// fullName is the dotted name a declaration has in C#, without its source path.
func fullName(node graph.Node) string {
	return strings.TrimPrefix(node.QualifiedName, node.Evidence.Span.Path+"::")
}

// visibleSymbols is what one project can see: its own declarations, which win
// for a name both declare, and the declarations of the projects it references.
type visibleSymbols struct {
	own        *projectSymbols
	referenced *projectSymbols
}

func newVisibleSymbols() *visibleSymbols {
	return &visibleSymbols{own: newProjectSymbols(), referenced: newProjectSymbols()}
}

func (visible *visibleSymbols) tiers() []*projectSymbols {
	return []*projectSymbols{visible.own, visible.referenced}
}

func (visible *visibleSymbols) file(path string) (graph.Node, bool) {
	for _, tier := range visible.tiers() {
		if file, found := tier.files[path]; found {
			return file, true
		}
	}
	return graph.Node{}, false
}

func resolveWith(contributions []extractor.Contribution, visible *visibleSymbols) (Resolution, error) {
	resolution := Resolution{}
	imports := Resolution{}
	typeFacts := graph.Facts{}
	links := map[[2]string]graph.FactEvidence{}
	for _, contribution := range contributions {
		resolveSymbols(contribution, visible, &resolution, &typeFacts)
		resolveImports(contribution, visible, &imports, links)
	}
	for link, evidence := range links {
		imports.facts.Edges = append(imports.facts.Edges, graph.Edge{SourceID: link[0], TargetID: link[1], Relation: ImportsFromRelation, Evidence: evidence})
	}
	imports.facts.Nodes = uniqueNodes(imports.facts.Nodes)
	vocabulary, err := ResolverVocabulary()
	if err != nil {
		return Resolution{}, fmt.Errorf("get C# resolver vocabulary: %w", err)
	}
	typeFacts.Nodes = uniqueNodes(typeFacts.Nodes)
	for _, facts := range []graph.Facts{imports.facts, typeFacts} {
		if err := vocabulary.Validate(facts); err != nil {
			return Resolution{}, fmt.Errorf("validate C# resolution: %w", err)
		}
	}
	resolution.facts.Nodes = uniqueNodes(append(imports.facts.Nodes, typeFacts.Nodes...))
	resolution.facts.Edges = append(resolution.facts.Edges, imports.facts.Edges...)
	resolution.facts.Edges = append(resolution.facts.Edges, typeFacts.Edges...)
	resolution.diagnostics = append(resolution.diagnostics, imports.diagnostics...)
	sort.SliceStable(resolution.facts.Edges, func(left, right int) bool {
		a, b := resolution.facts.Edges[left], resolution.facts.Edges[right]
		if a.SourceID != b.SourceID {
			return a.SourceID < b.SourceID
		}
		if a.TargetID != b.TargetID {
			return a.TargetID < b.TargetID
		}
		return a.Relation < b.Relation
	})
	return resolution, nil
}

func resolveImports(contribution extractor.Contribution, visible *visibleSymbols, resolution *Resolution, links map[[2]string]graph.FactEvidence) {
	facts := contribution.Facts()
	var sourceFile graph.Node
	haveFile := false
	nodes := make(map[string]graph.Node, len(facts.Nodes))
	for _, node := range facts.Nodes {
		nodes[node.ID] = node
		if node.Kind == "file" {
			sourceFile, haveFile = node, true
		}
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
		targets, ambiguous := importTargets(reference, enclosingNamespaces(nodes[owners[source.ID]]), visible)
		if ambiguous {
			resolution.diagnostics = append(resolution.diagnostics, extractor.Diagnostic{Severity: extractor.DiagnosticWarning, Message: fmt.Sprintf("C# import %q from %q is ambiguous", reference.Target, contribution.SourcePath())})
		}
		for _, target := range targets {
			resolution.facts.Edges = append(resolution.facts.Edges, graph.Edge{SourceID: source.ID, TargetID: target.ID, Relation: ImportsFromRelation, Evidence: source.Evidence})
			resolution.facts.Nodes = append(resolution.facts.Nodes, source, target)
			if targetFile, found := visible.file(target.Evidence.Span.Path); haveFile && found && targetFile.ID != sourceFile.ID {
				links[[2]string{sourceFile.ID, targetFile.ID}] = sourceFile.Evidence
				resolution.facts.Nodes = append(resolution.facts.Nodes, sourceFile, targetFile)
			}
		}
	}
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
// target. A namespace import names every declaration of the namespace in the
// project and the projects it references; a static or alias import names a
// type only when exactly one declares it.
func importTargets(reference extractor.UnresolvedReference, scopes []string, visible *visibleSymbols) ([]graph.Node, bool) {
	static := len(reference.Bindings) == 1 && reference.Bindings[0].ExportedName == StaticBinding
	alias := len(reference.Bindings) == 1 && reference.Bindings[0].LocalName != ""
	for _, scope := range scopes {
		name := scoped(scope, reference.Target)
		if static || alias {
			types, _ := visible.types(name)
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
		var namespaces []graph.Node
		for _, tier := range visible.tiers() {
			namespaces = append(namespaces, tier.namespaces[name]...)
		}
		if len(namespaces) > 0 {
			return namespaces, false
		}
	}
	return nil, false
}

// types returns the declarations of a full type name: the project's own when it
// declares any, otherwise those of the referenced projects.
func (visible *visibleSymbols) types(full string) ([]graph.Node, *projectSymbols) {
	for _, tier := range visible.tiers() {
		if matches := tier.types[full]; len(matches) > 0 {
			return matches, tier
		}
	}
	return nil, nil
}

func resolveSymbols(contribution extractor.Contribution, visible *visibleSymbols, resolution *Resolution, typeFacts *graph.Facts) {
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
		scopes := lookupScopes(fullName(source))
		var matches []graph.Node
		switch reference.Relation {
		case BaseTypeRelation, ExtendsRelation, ImplementsRelation:
			// A base list is read outside the declaring type's own members.
			matches, _, _ = lookupType(visible, scopes[1:], reference.Target)
			if len(matches) == 1 {
				if relation, valid := typeRelation(source.Kind, matches[0].Kind, reference.Relation); valid {
					typeFacts.Nodes = append(typeFacts.Nodes, source, matches[0])
					typeFacts.Edges = append(typeFacts.Edges, graph.Edge{SourceID: source.ID, TargetID: matches[0].ID, Relation: relation, Evidence: reference.Evidence})
				}
				continue
			}
		case ReferencesRelation:
			matches, _, _ = lookupType(visible, scopes, reference.Target)
		case CallsRelation:
			matches = lookupMethod(visible, scopes, reference.Target)
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
	switch relation {
	case CallsRelation:
		return "call"
	case BaseTypeRelation, ExtendsRelation, ImplementsRelation:
		return "base type"
	}
	return "reference"
}

// typeRelation gives the edge a base-list entry produces between a declaration
// and the unique type it names. A target the language does not allow in that
// position, such as a struct base class or an enum interface, produces no edge.
func typeRelation(source, target graph.NodeKind, extracted graph.RelationKind) (graph.RelationKind, bool) {
	if target == InterfaceNodeKind {
		if source == InterfaceNodeKind {
			return ExtendsRelation, true
		}
		return ImplementsRelation, source == ClassNodeKind || source == StructNodeKind || source == RecordNodeKind
	}
	if extracted == BaseTypeRelation && source == target && (source == ClassNodeKind || source == RecordNodeKind) {
		return ExtendsRelation, true
	}
	return "", false
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
// that declares the name wins; within it the project's own declarations win over
// referenced ones, and several declarations are ambiguous. It also returns the
// declarations' full name and the project set they were found in.
func lookupType(visible *visibleSymbols, scopes []string, name string) ([]graph.Node, *projectSymbols, string) {
	for _, scope := range scopes {
		full := scoped(scope, name)
		if matches, tier := visible.types(full); len(matches) > 0 {
			return matches, tier, full
		}
	}
	return nil, nil, ""
}

// lookupMethod resolves a call target written as `Method` (a method of an
// enclosing type) or `Receiver.Method` (a method of the named type).
func lookupMethod(visible *visibleSymbols, scopes []string, target string) []graph.Node {
	if position := strings.LastIndex(target, "."); position >= 0 {
		matches, tier, full := lookupType(visible, scopes, target[:position])
		if len(matches) != 1 {
			return matches
		}
		return tier.methods[full+"."+target[position+1:]]
	}
	for _, scope := range scopes {
		for _, tier := range visible.tiers() {
			if len(tier.types[scope]) == 0 {
				continue
			}
			// The first project declaring the enclosing type shadows later ones.
			return tier.methods[scope+"."+target]
		}
	}
	return nil
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
