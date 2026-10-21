package javascript

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"sort"
	"strings"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
)

const (
	ImportsFromRelation graph.RelationKind = "javascript:imports_from"
	ReExportsRelation   graph.RelationKind = "javascript:re_exports"
	ExtendsRelation     graph.RelationKind = "javascript:extends"
	CallsRelation       graph.RelationKind = "javascript:calls"
)

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

func ResolverVocabulary() (graph.Vocabulary, error) {
	declarationKinds := []graph.NodeKind{ClassNodeKind, FunctionNodeKind, MethodNodeKind, VariableNodeKind}
	nodeKinds := append([]graph.NodeKind{"file"}, declarationKinds...)
	endpoints := []graph.EndpointRule{{Source: "file", Target: "file"}}
	for _, kind := range declarationKinds {
		endpoints = append(endpoints, graph.EndpointRule{Source: "file", Target: kind})
	}
	return graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: nodeKinds,
		Relations: []graph.RelationDefinition{{
			Kind:      ImportsFromRelation,
			Endpoints: endpoints,
		}, {
			Kind:      ReExportsRelation,
			Endpoints: endpoints,
		}, {
			Kind:      ExtendsRelation,
			Endpoints: []graph.EndpointRule{{Source: ClassNodeKind, Target: ClassNodeKind}},
		}, {
			Kind: CallsRelation,
			Endpoints: []graph.EndpointRule{
				{Source: FunctionNodeKind, Target: FunctionNodeKind},
				{Source: FunctionNodeKind, Target: MethodNodeKind},
				{Source: FunctionNodeKind, Target: VariableNodeKind},
				{Source: MethodNodeKind, Target: FunctionNodeKind},
				{Source: MethodNodeKind, Target: MethodNodeKind},
				{Source: MethodNodeKind, Target: VariableNodeKind},
			},
		}},
	})
}

func Resolve(contributions []extractor.Contribution) (Resolution, error) {
	return resolve(contributions, extractor.ResolverFileView{})
}

func ResolveWithFileView(contributions []extractor.Contribution, view extractor.ResolverFileView) (Resolution, error) {
	return resolve(contributions, view)
}

func ResolvePage(ctx context.Context, contributions []extractor.Contribution, projectID string, index extractor.ResolverIndex) (Resolution, error) {
	if projectID == "" || index == nil {
		return Resolution{}, fmt.Errorf("resolve JavaScript page: project and resolver index are required")
	}
	index = extractor.NewPageResolverIndex(index)
	files := make(map[string]graph.Node, len(contributions))
	byPath := make(map[string]extractor.Contribution, len(contributions))
	nodes := make(map[string]graph.Node)
	for _, contribution := range contributions {
		file, found := fileFact(contribution)
		if !found {
			return Resolution{}, fmt.Errorf("resolve JavaScript contribution %q: file fact is required", contribution.SourcePath())
		}
		files[contribution.SourcePath()] = file
		byPath[contribution.SourcePath()] = contribution
		for _, node := range contribution.Facts().Nodes {
			if isResolverNodeKind(node.Kind) {
				nodes[node.ID] = node
			}
		}
	}
	paths := make([]string, 0, len(files))
	for sourcePath := range files {
		paths = append(paths, sourcePath)
	}
	sort.Strings(paths)
	resolution := Resolution{}
	for _, sourcePath := range paths {
		for _, reference := range sortedReferences(byPath[sourcePath].UnresolvedReferences()) {
			target, found, err := resolverPageTarget(ctx, sourcePath, reference.Target, projectID, index)
			if err != nil {
				return Resolution{}, err
			}
			if !found {
				resolution.diagnostics = append(resolution.diagnostics, extractor.Diagnostic{Severity: extractor.DiagnosticWarning, Message: fmt.Sprintf("JavaScript module %q from %q is not indexed", reference.Target, sourcePath)})
				continue
			}
			targetFile, found := targetFile(target.Nodes)
			if !found {
				return Resolution{}, fmt.Errorf("resolve JavaScript target %q: file fact is required", target.SourcePath)
			}
			for _, node := range target.Nodes {
				if isResolverNodeKind(node.Kind) {
					nodes[node.ID] = node
				}
			}
			exportedSurfaces, err := resolverPageExportedSurfaces(ctx, target, index, make(map[string]struct{}), nodes)
			if err != nil {
				return Resolution{}, err
			}
			relation, err := relationFor(reference.Kind)
			if err != nil {
				return Resolution{}, err
			}
			evidence := files[sourcePath].Evidence
			if reference.Ambiguous {
				evidence.Confidence = graph.ConfidenceAmbiguous
			}
			resolution.facts.Edges = append(resolution.facts.Edges, graph.Edge{SourceID: reference.SourceID, TargetID: targetFile.ID, Relation: relation, Evidence: evidence})
			for _, binding := range reference.Bindings {
				matches := matchingBindingSurfaces(exportedSurfaces, reference.Kind, binding)
				if len(matches) == 0 && binding.ImportedName != "*" {
					resolution.diagnostics = append(resolution.diagnostics, extractor.Diagnostic{Severity: extractor.DiagnosticWarning, Message: fmt.Sprintf("JavaScript export %q from %q is not indexed", binding.ImportedName, reference.Target)})
				}
				for _, surface := range matches {
					resolution.facts.Edges = append(resolution.facts.Edges, graph.Edge{SourceID: reference.SourceID, TargetID: surface.NodeID, Relation: relation, Evidence: evidence})
				}
			}
		}
		for _, reference := range byPath[sourcePath].SymbolReferences() {
			targets, err := resolverPageSymbolTargets(ctx, sourcePath, reference.Target, projectID, index, byPath[sourcePath].UnresolvedReferences(), nodes)
			if err != nil {
				return Resolution{}, err
			}
			for _, target := range targets {
				resolution.facts.Edges = append(resolution.facts.Edges, graph.Edge{SourceID: reference.SourceID, TargetID: target, Relation: reference.Relation, Evidence: reference.Evidence})
			}
		}
	}
	for _, node := range nodes {
		resolution.facts.Nodes = append(resolution.facts.Nodes, node)
	}
	sort.Slice(resolution.facts.Nodes, func(left, right int) bool { return resolution.facts.Nodes[left].ID < resolution.facts.Nodes[right].ID })
	sort.Slice(resolution.facts.Edges, func(left, right int) bool {
		if resolution.facts.Edges[left].SourceID != resolution.facts.Edges[right].SourceID {
			return resolution.facts.Edges[left].SourceID < resolution.facts.Edges[right].SourceID
		}
		if resolution.facts.Edges[left].TargetID != resolution.facts.Edges[right].TargetID {
			return resolution.facts.Edges[left].TargetID < resolution.facts.Edges[right].TargetID
		}
		return resolution.facts.Edges[left].Relation < resolution.facts.Edges[right].Relation
	})
	vocabulary, err := ResolverVocabulary()
	if err != nil {
		return Resolution{}, fmt.Errorf("get JavaScript resolver vocabulary: %w", err)
	}
	if err := vocabulary.Validate(resolution.facts); err != nil {
		return Resolution{}, fmt.Errorf("validate JavaScript page resolution: %w", err)
	}
	return resolution, nil
}

func resolverPageSymbolTargets(ctx context.Context, sourcePath, name, projectID string, index extractor.ResolverIndex, references []extractor.UnresolvedReference, nodes map[string]graph.Node) ([]string, error) {
	targets := make([]string, 0)
	for _, reference := range references {
		if reference.Kind != extractor.ModuleReferenceImport {
			continue
		}
		target, found, err := resolverPageTarget(ctx, sourcePath, reference.Target, projectID, index)
		if err != nil {
			return nil, err
		}
		if !found {
			continue
		}
		exportedSurfaces, err := resolverPageExportedSurfaces(ctx, target, index, make(map[string]struct{}), nodes)
		if err != nil {
			return nil, err
		}
		for _, binding := range reference.Bindings {
			localName := binding.ImportedName
			if binding.LocalName != "" {
				localName = binding.LocalName
			}
			if localName != name {
				continue
			}
			for _, surface := range matchingBindingSurfaces(exportedSurfaces, reference.Kind, binding) {
				targets = append(targets, surface.NodeID)
			}
		}
	}
	return targets, nil
}

func resolverPageExportedSurfaces(ctx context.Context, target extractor.ResolverTarget, index extractor.ResolverIndex, visited map[string]struct{}, nodes map[string]graph.Node) ([]extractor.ExportedSurface, error) {
	key := target.ProjectID + "\x00" + target.SourcePath
	if _, found := visited[key]; found {
		return nil, nil
	}
	visited[key] = struct{}{}
	defer delete(visited, key)
	for _, node := range target.Nodes {
		if isResolverNodeKind(node.Kind) {
			nodes[node.ID] = node
		}
	}
	surfaces := append([]extractor.ExportedSurface(nil), target.ExportedSurfaces...)
	for _, reference := range target.UnresolvedReferences {
		if reference.Kind != extractor.ModuleReferenceReExport {
			continue
		}
		reexport, found, err := resolverPageTarget(ctx, target.SourcePath, reference.Target, target.ProjectID, index)
		if err != nil {
			return nil, err
		}
		if !found {
			continue
		}
		reexported, err := resolverPageExportedSurfaces(ctx, reexport, index, visited, nodes)
		if err != nil {
			return nil, err
		}
		for _, binding := range reference.Bindings {
			for _, surface := range matchingBindingSurfaces(reexported, reference.Kind, binding) {
				name := surface.Name
				if binding.ExportedName != "" && binding.ExportedName != "*" {
					name = binding.ExportedName
				}
				surfaces = append(surfaces, extractor.ExportedSurface{NodeID: surface.NodeID, Name: name})
			}
		}
	}
	return surfaces, nil
}

func resolverPageTarget(ctx context.Context, sourcePath, specifier, projectID string, index extractor.ResolverIndex) (extractor.ResolverTarget, bool, error) {
	if !strings.HasPrefix(specifier, ".") {
		return resolverPagePackageTarget(ctx, specifier, index)
	}
	base := path.Clean(path.Join(path.Dir(sourcePath), specifier))
	for _, candidate := range resolverPathCandidates(base) {
		target, found, err := index.ResolverTarget(ctx, extractor.ResolverTargetRequest{ProjectID: projectID, Language: "javascript", SourcePath: candidate})
		if err != nil {
			return extractor.ResolverTarget{}, false, fmt.Errorf("read JavaScript resolver target %q: %w", candidate, err)
		}
		if found {
			return target, true, nil
		}
	}
	return extractor.ResolverTarget{}, false, nil
}

func resolverPagePackageTarget(ctx context.Context, specifier string, index extractor.ResolverIndex) (extractor.ResolverTarget, bool, error) {
	packageName, subpath, found := splitPackageSpecifier(specifier)
	if !found {
		return extractor.ResolverTarget{}, false, nil
	}
	packageBase := path.Base(packageName)
	projectID := "project:packages/" + packageBase
	packagePath := path.Join("packages", packageBase, "src")
	if subpath != "" {
		packagePath = path.Join(packagePath, subpath)
	}
	for after := ""; ; {
		targets, err := index.ResolverPackagePage(ctx, extractor.ResolverPackagePageRequest{
			ProjectID:       projectID,
			Language:        "javascript",
			PackagePath:     packagePath,
			AfterSourcePath: after,
			Limit:           128,
		})
		if err != nil {
			return extractor.ResolverTarget{}, false, fmt.Errorf("read JavaScript package %q: %w", specifier, err)
		}
		if len(targets) == 0 {
			return extractor.ResolverTarget{}, false, nil
		}
		for _, target := range targets {
			if packageTargetMatches(target.SourcePath, subpath) {
				return target, true, nil
			}
			after = target.SourcePath
		}
	}
}

func packageTargetMatches(sourcePath, subpath string) bool {
	base := strings.TrimSuffix(path.Base(sourcePath), path.Ext(sourcePath))
	if subpath == "" {
		return base == "index"
	}
	return base == strings.TrimSuffix(path.Base(subpath), path.Ext(subpath))
}

func resolverPathCandidates(base string) []string {
	candidates := []string{base}
	for _, extension := range []string{".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"} {
		candidates = append(candidates, base+extension)
	}
	for _, extension := range []string{".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"} {
		candidates = append(candidates, path.Join(base, "index"+extension))
	}
	return candidates
}

func targetFile(nodes []graph.Node) (graph.Node, bool) {
	for _, node := range nodes {
		if node.Kind == "file" {
			return node, true
		}
	}
	return graph.Node{}, false
}

func resolve(contributions []extractor.Contribution, view extractor.ResolverFileView) (Resolution, error) {
	files := make(map[string]graph.Node, len(contributions))
	byPath := make(map[string]extractor.Contribution, len(contributions))
	nodes := make(map[string]graph.Node)
	for _, contribution := range contributions {
		file, found := fileFact(contribution)
		if !found {
			return Resolution{}, fmt.Errorf("resolve JavaScript contribution %q: file fact is required", contribution.SourcePath())
		}
		files[contribution.SourcePath()] = file
		byPath[contribution.SourcePath()] = contribution
		for _, node := range contribution.Facts().Nodes {
			if isResolverNodeKind(node.Kind) {
				nodes[node.ID] = node
			}
		}
	}

	paths := make([]string, 0, len(files))
	for sourcePath := range files {
		paths = append(paths, sourcePath)
	}
	sort.Strings(paths)
	surfaces := resolvedSurfaces(paths, byPath, files)

	resolution := Resolution{facts: graph.Facts{Nodes: make([]graph.Node, 0, len(nodes))}}
	for _, node := range nodes {
		resolution.facts.Nodes = append(resolution.facts.Nodes, node)
	}
	for _, sourcePath := range paths {
		for _, reference := range sortedReferences(byPath[sourcePath].UnresolvedReferences()) {
			targetPath, found := resolveSpecifier(sourcePath, reference.Target, reference.Kind, files, view)
			if !found {
				resolution.diagnostics = append(resolution.diagnostics, extractor.Diagnostic{
					Severity: extractor.DiagnosticWarning,
					Message:  fmt.Sprintf("JavaScript module %q from %q is not indexed", reference.Target, sourcePath),
				})
				continue
			}
			relation, err := relationFor(reference.Kind)
			if err != nil {
				return Resolution{}, err
			}
			evidence := files[sourcePath].Evidence
			if reference.Ambiguous {
				evidence.Confidence = graph.ConfidenceAmbiguous
			}
			resolution.facts.Edges = append(resolution.facts.Edges, graph.Edge{
				SourceID: reference.SourceID,
				TargetID: files[targetPath].ID,
				Relation: relation,
				Evidence: evidence,
			})
			for _, binding := range reference.Bindings {
				matches := matchingBindingSurfaces(surfaces[targetPath], reference.Kind, binding)
				if len(matches) == 0 && binding.ImportedName != "*" {
					resolution.diagnostics = append(resolution.diagnostics, extractor.Diagnostic{
						Severity: extractor.DiagnosticWarning,
						Message:  fmt.Sprintf("JavaScript export %q from %q is not indexed", binding.ImportedName, reference.Target),
					})
				}
				for _, surface := range matches {
					resolution.facts.Edges = append(resolution.facts.Edges, graph.Edge{
						SourceID: reference.SourceID,
						TargetID: surface.NodeID,
						Relation: relation,
						Evidence: evidence,
					})
				}
			}
		}
	}
	for _, sourcePath := range paths {
		for _, reference := range byPath[sourcePath].SymbolReferences() {
			for _, target := range resolvedSymbolTargets(sourcePath, reference.Target, byPath, surfaces, files, view) {
				resolution.facts.Edges = append(resolution.facts.Edges, graph.Edge{
					SourceID: reference.SourceID,
					TargetID: target,
					Relation: reference.Relation,
					Evidence: reference.Evidence,
				})
			}
		}
	}

	sort.Slice(resolution.facts.Nodes, func(left, right int) bool {
		return resolution.facts.Nodes[left].ID < resolution.facts.Nodes[right].ID
	})
	sort.Slice(resolution.facts.Edges, func(left, right int) bool {
		if resolution.facts.Edges[left].SourceID != resolution.facts.Edges[right].SourceID {
			return resolution.facts.Edges[left].SourceID < resolution.facts.Edges[right].SourceID
		}
		if resolution.facts.Edges[left].TargetID != resolution.facts.Edges[right].TargetID {
			return resolution.facts.Edges[left].TargetID < resolution.facts.Edges[right].TargetID
		}
		return resolution.facts.Edges[left].Relation < resolution.facts.Edges[right].Relation
	})
	sort.Slice(resolution.diagnostics, func(left, right int) bool {
		return resolution.diagnostics[left].Message < resolution.diagnostics[right].Message
	})

	vocabulary, err := ResolverVocabulary()
	if err != nil {
		return Resolution{}, fmt.Errorf("get JavaScript resolver vocabulary: %w", err)
	}
	if err := vocabulary.Validate(resolution.facts); err != nil {
		return Resolution{}, fmt.Errorf("validate JavaScript resolution: %w", err)
	}
	return resolution, nil
}

func relationFor(kind extractor.ModuleReferenceKind) (graph.RelationKind, error) {
	switch kind {
	case extractor.ModuleReferenceImport:
		return ImportsFromRelation, nil
	case extractor.ModuleReferenceRequire:
		return ImportsFromRelation, nil
	case extractor.ModuleReferenceReExport:
		return ReExportsRelation, nil
	default:
		return "", fmt.Errorf("resolve JavaScript module reference: unsupported kind %q", kind)
	}
}

func fileFact(contribution extractor.Contribution) (graph.Node, bool) {
	for _, node := range contribution.Facts().Nodes {
		if node.Kind == "file" {
			return node, true
		}
	}
	return graph.Node{}, false
}

func isResolverNodeKind(kind graph.NodeKind) bool {
	switch kind {
	case "file", ClassNodeKind, FunctionNodeKind, MethodNodeKind, VariableNodeKind:
		return true
	default:
		return false
	}
}

func matchingSurfaces(surfaces []extractor.ExportedSurface, name string) []extractor.ExportedSurface {
	matching := make([]extractor.ExportedSurface, 0, len(surfaces))
	for _, surface := range surfaces {
		if name == "*" || surface.Name == name {
			matching = append(matching, surface)
		}
	}
	return matching
}

func matchingBindingSurfaces(surfaces []extractor.ExportedSurface, kind extractor.ModuleReferenceKind, binding extractor.ModuleBinding) []extractor.ExportedSurface {
	matching := matchingSurfaces(surfaces, binding.ImportedName)
	if kind != extractor.ModuleReferenceReExport || binding.ImportedName != "*" || binding.ExportedName != "*" {
		return matching
	}
	withoutDefault := matching[:0]
	for _, surface := range matching {
		if surface.Name != "default" {
			withoutDefault = append(withoutDefault, surface)
		}
	}
	return withoutDefault
}

func resolvedSymbolTargets(sourcePath, name string, contributions map[string]extractor.Contribution, surfaces map[string][]extractor.ExportedSurface, files map[string]graph.Node, view extractor.ResolverFileView) []string {
	targets := make([]string, 0)
	for _, reference := range contributions[sourcePath].UnresolvedReferences() {
		if reference.Kind != extractor.ModuleReferenceImport {
			continue
		}
		targetPath, found := resolveSpecifier(sourcePath, reference.Target, reference.Kind, files, view)
		if !found {
			continue
		}
		for _, binding := range reference.Bindings {
			localName := binding.ImportedName
			if binding.LocalName != "" {
				localName = binding.LocalName
			}
			if localName != name {
				continue
			}
			for _, surface := range matchingBindingSurfaces(surfaces[targetPath], reference.Kind, binding) {
				targets = append(targets, surface.NodeID)
			}
		}
	}
	return targets
}

func resolvedSurfaces(paths []string, contributions map[string]extractor.Contribution, files map[string]graph.Node) map[string][]extractor.ExportedSurface {
	surfaces := make(map[string][]extractor.ExportedSurface, len(paths))
	seen := make(map[string]map[string]struct{}, len(paths))
	for _, sourcePath := range paths {
		for _, surface := range contributions[sourcePath].ExportedSurfaces() {
			addSurface(surfaces, seen, sourcePath, surface)
		}
	}

	for range paths {
		changed := false
		for _, sourcePath := range paths {
			for _, reference := range sortedReferences(contributions[sourcePath].UnresolvedReferences()) {
				if reference.Kind != extractor.ModuleReferenceReExport {
					continue
				}
				targetPath, found := resolveRelativeSpecifier(sourcePath, reference.Target, files)
				if !found {
					continue
				}
				for _, binding := range reference.Bindings {
					for _, surface := range matchingBindingSurfaces(surfaces[targetPath], reference.Kind, binding) {
						exportName := surface.Name
						if binding.ExportedName != "" && binding.ExportedName != "*" {
							exportName = binding.ExportedName
						}
						if addSurface(surfaces, seen, sourcePath, extractor.ExportedSurface{NodeID: surface.NodeID, Name: exportName}) {
							changed = true
						}
					}
				}
			}
		}
		if !changed {
			break
		}
	}
	return surfaces
}

func addSurface(surfaces map[string][]extractor.ExportedSurface, seen map[string]map[string]struct{}, sourcePath string, surface extractor.ExportedSurface) bool {
	key := surface.Name + "\x00" + surface.NodeID
	if seen[sourcePath] == nil {
		seen[sourcePath] = make(map[string]struct{})
	}
	if _, exists := seen[sourcePath][key]; exists {
		return false
	}
	seen[sourcePath][key] = struct{}{}
	surfaces[sourcePath] = append(surfaces[sourcePath], surface)
	return true
}

func resolveSpecifier(sourcePath, specifier string, kind extractor.ModuleReferenceKind, files map[string]graph.Node, view extractor.ResolverFileView) (string, bool) {
	if strings.HasPrefix(specifier, ".") {
		return resolveRelativeSpecifier(sourcePath, specifier, files)
	}
	return resolvePackageSpecifier(sourcePath, specifier, kind, files, view)
}

type packageManifest struct {
	Exports json.RawMessage `json:"exports"`
	Main    string          `json:"main"`
}

func resolvePackageSpecifier(sourcePath, specifier string, kind extractor.ModuleReferenceKind, files map[string]graph.Node, view extractor.ResolverFileView) (string, bool) {
	packageName, subpath, found := splitPackageSpecifier(specifier)
	if !found || view.ProjectRoot() == "" {
		return "", false
	}

	projectRoot := view.ProjectRoot()
	for directory := path.Dir(sourcePath); ; directory = path.Dir(directory) {
		packageDirectory := path.Join(directory, "node_modules", packageName)
		contents, found := view.File(path.Join(packageDirectory, "package.json"))
		if found {
			var manifest packageManifest
			if err := json.Unmarshal(contents, &manifest); err == nil {
				if len(manifest.Exports) > 0 {
					if target, found := selectPackageExport(manifest.Exports, subpath, packageExportCondition(kind)); found {
						return resolvePath(path.Join(packageDirectory, target), files)
					}
					return "", false
				}
				entry := subpath
				if entry == "" {
					entry = manifest.Main
					if entry == "" {
						entry = "index"
					}
				}
				return resolvePath(path.Join(packageDirectory, entry), files)
			}
		}

		if directory == projectRoot || directory == "." {
			break
		}
	}
	return "", false
}

func splitPackageSpecifier(specifier string) (string, string, bool) {
	parts := strings.Split(specifier, "/")
	if specifier == "" || strings.HasPrefix(specifier, ".") {
		return "", "", false
	}
	if strings.HasPrefix(specifier, "@") {
		if len(parts) < 2 || parts[1] == "" {
			return "", "", false
		}
		return strings.Join(parts[:2], "/"), strings.Join(parts[2:], "/"), true
	}
	return parts[0], strings.Join(parts[1:], "/"), true
}

func packageExportCondition(kind extractor.ModuleReferenceKind) string {
	if kind == extractor.ModuleReferenceRequire {
		return "require"
	}
	return "import"
}

func selectPackageExport(raw json.RawMessage, subpath, condition string) (string, bool) {
	var target string
	if err := json.Unmarshal(raw, &target); err == nil {
		return target, true
	}

	var values map[string]json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return "", false
	}
	if subpath != "" {
		return selectPackageExport(values["./"+subpath], "", condition)
	}
	if root, found := values["."]; found {
		return selectPackageExport(root, "", condition)
	}
	for _, candidateCondition := range []string{condition, "default"} {
		if candidate, found := values[candidateCondition]; found {
			return selectPackageExport(candidate, "", condition)
		}
	}
	return "", false
}

func resolveRelativeSpecifier(sourcePath, specifier string, files map[string]graph.Node) (string, bool) {
	if !strings.HasPrefix(specifier, ".") {
		return "", false
	}

	base := path.Clean(path.Join(path.Dir(sourcePath), specifier))
	return resolvePath(base, files)
}

func resolvePath(base string, files map[string]graph.Node) (string, bool) {
	candidates := []string{base}
	for _, extension := range []string{".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"} {
		candidates = append(candidates, base+extension)
	}
	for _, extension := range []string{".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"} {
		candidates = append(candidates, path.Join(base, "index"+extension))
	}
	for _, candidate := range candidates {
		if _, found := files[candidate]; found {
			return candidate, true
		}
	}
	return "", false
}

func sortedReferences(references []extractor.UnresolvedReference) []extractor.UnresolvedReference {
	sorted := append([]extractor.UnresolvedReference(nil), references...)
	sort.Slice(sorted, func(left, right int) bool {
		if sorted[left].SourceID != sorted[right].SourceID {
			return sorted[left].SourceID < sorted[right].SourceID
		}
		return sorted[left].Target < sorted[right].Target
	})
	return sorted
}
