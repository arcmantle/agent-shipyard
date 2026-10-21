package typescript

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
	ImportsFromRelation graph.RelationKind = "typescript:imports_from"
	ReExportsRelation   graph.RelationKind = "typescript:re_exports"
	ExtendsRelation     graph.RelationKind = "typescript:extends"
	ImplementsRelation  graph.RelationKind = "typescript:implements"
	CallsRelation       graph.RelationKind = "typescript:calls"
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
	declarationKinds := []graph.NodeKind{ClassNodeKind, FunctionNodeKind, MethodNodeKind, InterfaceNodeKind, TypeAliasNodeKind, VariableNodeKind}
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
			Kind: ExtendsRelation,
			Endpoints: []graph.EndpointRule{
				{Source: ClassNodeKind, Target: ClassNodeKind},
				{Source: ClassNodeKind, Target: InterfaceNodeKind},
				{Source: ClassNodeKind, Target: VariableNodeKind},
				{Source: InterfaceNodeKind, Target: InterfaceNodeKind},
				{Source: InterfaceNodeKind, Target: TypeAliasNodeKind},
			},
		}, {
			Kind:      ImplementsRelation,
			Endpoints: []graph.EndpointRule{{Source: ClassNodeKind, Target: InterfaceNodeKind}},
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
		return Resolution{}, fmt.Errorf("resolve TypeScript page: project and resolver index are required")
	}
	index = extractor.NewPageResolverIndex(index)
	files := make(map[string]graph.Node, len(contributions))
	contributionsByPath := make(map[string]extractor.Contribution, len(contributions))
	nodes := make(map[string]graph.Node)
	for _, contribution := range contributions {
		file, found := fileFact(contribution)
		if !found {
			return Resolution{}, fmt.Errorf("resolve TypeScript contribution %q: file fact is required", contribution.SourcePath())
		}
		files[contribution.SourcePath()] = file
		contributionsByPath[contribution.SourcePath()] = contribution
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
	resolution := Resolution{facts: graph.Facts{Nodes: make([]graph.Node, 0, len(nodes))}}
	for _, node := range nodes {
		resolution.facts.Nodes = append(resolution.facts.Nodes, node)
	}
	for _, sourcePath := range paths {
		for _, reference := range sortedReferences(contributionsByPath[sourcePath].UnresolvedReferences()) {
			target, found, err := resolverPageTarget(ctx, sourcePath, reference.Target, projectID, index)
			if err != nil {
				return Resolution{}, err
			}
			if !found {
				resolution.diagnostics = append(resolution.diagnostics, extractor.Diagnostic{Severity: extractor.DiagnosticWarning, Message: fmt.Sprintf("TypeScript module %q from %q is not indexed", reference.Target, sourcePath)})
				continue
			}
			targetFile, found := targetFile(target.Nodes)
			if !found {
				return Resolution{}, fmt.Errorf("resolve TypeScript target %q: file fact is required", target.SourcePath)
			}
			for _, node := range target.Nodes {
				if isResolverNodeKind(node.Kind) {
					nodes[node.ID] = node
				}
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
				matches := matchingBindingSurfaces(target.ExportedSurfaces, reference.Kind, binding)
				if len(matches) == 0 && binding.ImportedName != "*" {
					resolution.diagnostics = append(resolution.diagnostics, extractor.Diagnostic{Severity: extractor.DiagnosticWarning, Message: fmt.Sprintf("TypeScript export %q from %q is not indexed", binding.ImportedName, reference.Target)})
				}
				for _, surface := range matches {
					resolution.facts.Edges = append(resolution.facts.Edges, graph.Edge{SourceID: reference.SourceID, TargetID: surface.NodeID, Relation: relation, Evidence: evidence})
				}
			}
		}
		for _, reference := range contributionsByPath[sourcePath].SymbolReferences() {
			targets, err := resolverPageSymbolTargets(ctx, sourcePath, reference.Target, projectID, index, contributionsByPath[sourcePath].UnresolvedReferences(), nodes)
			if err != nil {
				return Resolution{}, err
			}
			if reference.Relation == ImplementsRelation {
				filtered := targets[:0]
				for _, targetID := range targets {
					if nodes[targetID].Kind == InterfaceNodeKind {
						filtered = append(filtered, targetID)
					}
				}
				targets = filtered
			}
			for _, target := range targets {
				resolution.facts.Edges = append(resolution.facts.Edges, graph.Edge{SourceID: reference.SourceID, TargetID: target, Relation: reference.Relation, Evidence: reference.Evidence})
			}
		}
	}
	resolution.facts.Nodes = resolution.facts.Nodes[:0]
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
	sort.Slice(resolution.diagnostics, func(left, right int) bool {
		return resolution.diagnostics[left].Message < resolution.diagnostics[right].Message
	})
	vocabulary, err := ResolverVocabulary()
	if err != nil {
		return Resolution{}, fmt.Errorf("get TypeScript resolver vocabulary: %w", err)
	}
	if err := vocabulary.Validate(resolution.facts); err != nil {
		return Resolution{}, fmt.Errorf("validate TypeScript page resolution: %w", err)
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
		target, found, err := index.ResolverTarget(ctx, extractor.ResolverTargetRequest{ProjectID: projectID, Language: "typescript", SourcePath: candidate})
		if err != nil {
			return extractor.ResolverTarget{}, false, fmt.Errorf("read TypeScript resolver target %q: %w", candidate, err)
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
	packageRoots := []string{path.Join("packages", packageBase, "src")}
	if subpath != "" {
		packageRoots = []string{path.Join(packageRoots[0], subpath)}
	}
	for _, packagePath := range packageRoots {
		after := ""
		for {
			targets, err := index.ResolverPackagePage(ctx, extractor.ResolverPackagePageRequest{ProjectID: projectID, Language: "typescript", PackagePath: packagePath, AfterSourcePath: after, Limit: 128})
			if err != nil {
				return extractor.ResolverTarget{}, false, fmt.Errorf("read TypeScript package %q: %w", specifier, err)
			}
			if len(targets) == 0 {
				break
			}
			for _, target := range targets {
				if packageTargetMatches(target.SourcePath, packagePath, subpath) {
					return target, true, nil
				}
				after = target.SourcePath
			}
		}
	}
	return extractor.ResolverTarget{}, false, nil
}

func packageTargetMatches(sourcePath, packagePath, subpath string) bool {
	base := path.Base(sourcePath)
	if subpath == "" {
		return strings.TrimSuffix(base, path.Ext(base)) == "index"
	}
	wanted := path.Base(subpath)
	return strings.TrimSuffix(base, path.Ext(base)) == strings.TrimSuffix(wanted, path.Ext(wanted))
}

func resolverPathCandidates(base string) []string {
	for _, extension := range []string{".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"} {
		if strings.HasSuffix(base, extension) {
			base = strings.TrimSuffix(base, extension)
			break
		}
	}
	candidates := []string{base}
	for _, extension := range []string{".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"} {
		candidates = append(candidates, base+extension)
	}
	for _, extension := range []string{".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"} {
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
	nodes := make(map[string]graph.Node)
	for _, contribution := range contributions {
		file, found := fileFact(contribution)
		if !found {
			return Resolution{}, fmt.Errorf("resolve TypeScript contribution %q: file fact is required", contribution.SourcePath())
		}
		files[contribution.SourcePath()] = file
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

	byPath := make(map[string]extractor.Contribution, len(contributions))
	for _, contribution := range contributions {
		byPath[contribution.SourcePath()] = contribution
	}
	surfaces := resolvedSurfaces(paths, byPath, files)

	resolution := Resolution{
		facts:       graph.Facts{Nodes: make([]graph.Node, 0, len(nodes))},
		diagnostics: typeScriptConfigurationDiagnostics(paths, view),
	}
	for _, node := range nodes {
		resolution.facts.Nodes = append(resolution.facts.Nodes, node)
	}
	for _, sourcePath := range paths {
		for _, reference := range sortedReferences(byPath[sourcePath].UnresolvedReferences()) {
			targetPath, found := resolveSpecifier(sourcePath, reference.Target, files, view)
			if !found {
				resolution.diagnostics = append(resolution.diagnostics, extractor.Diagnostic{
					Severity: extractor.DiagnosticWarning,
					Message:  fmt.Sprintf("TypeScript module %q from %q is not indexed", reference.Target, sourcePath),
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
						Message:  fmt.Sprintf("TypeScript export %q from %q is not indexed", binding.ImportedName, reference.Target),
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
		return Resolution{}, fmt.Errorf("get TypeScript resolver vocabulary: %w", err)
	}
	if err := vocabulary.Validate(resolution.facts); err != nil {
		return Resolution{}, fmt.Errorf("validate TypeScript resolution: %w", err)
	}
	return resolution, nil
}

func relationFor(kind extractor.ModuleReferenceKind) (graph.RelationKind, error) {
	switch kind {
	case extractor.ModuleReferenceImport:
		return ImportsFromRelation, nil
	case extractor.ModuleReferenceReExport:
		return ReExportsRelation, nil
	default:
		return "", fmt.Errorf("resolve TypeScript module reference: unsupported kind %q", kind)
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
	case "file", ClassNodeKind, FunctionNodeKind, MethodNodeKind, InterfaceNodeKind, TypeAliasNodeKind, VariableNodeKind:
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
		targetPath, found := resolveSpecifier(sourcePath, reference.Target, files, view)
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

func resolveSpecifier(sourcePath, specifier string, files map[string]graph.Node, view extractor.ResolverFileView) (string, bool) {
	if strings.HasPrefix(specifier, ".") {
		return resolveRelativeSpecifier(sourcePath, specifier, files)
	}
	if targetPath, found := resolveTypeScriptPathAlias(sourcePath, specifier, files, view); found {
		return targetPath, true
	}
	return resolvePackageSpecifier(sourcePath, specifier, files, view)
}

func resolveTypeScriptPathAlias(sourcePath, specifier string, files map[string]graph.Node, view extractor.ResolverFileView) (string, bool) {
	configPath, config, found := nearestTSConfig(sourcePath, view)
	if !found {
		return "", false
	}
	pattern, suffix, found := longestMatchingPathPattern(specifier, config.CompilerOptions.Paths)
	if !found {
		return "", false
	}

	basePath := path.Dir(configPath)
	if config.CompilerOptions.BaseURL != "" {
		basePath = path.Join(basePath, config.CompilerOptions.BaseURL)
	}
	for _, target := range config.CompilerOptions.Paths[pattern] {
		candidate := strings.ReplaceAll(target, "*", suffix)
		if resolved, found := resolvePath(path.Join(basePath, candidate), files); found {
			return resolved, true
		}
	}
	return "", false
}

type tsConfig struct {
	CompilerOptions struct {
		BaseURL          string              `json:"baseUrl"`
		ModuleResolution string              `json:"moduleResolution"`
		Paths            map[string][]string `json:"paths"`
	} `json:"compilerOptions"`
}

func typeScriptConfigurationDiagnostics(paths []string, view extractor.ResolverFileView) []extractor.Diagnostic {
	diagnostics := make([]extractor.Diagnostic, 0)
	seen := make(map[string]struct{})
	for _, sourcePath := range paths {
		configPath, config, found := nearestTSConfig(sourcePath, view)
		if !found {
			continue
		}
		if _, exists := seen[configPath]; exists {
			continue
		}
		seen[configPath] = struct{}{}

		mode := strings.ToLower(config.CompilerOptions.ModuleResolution)
		if mode == "" || mode == "node16" || mode == "nodenext" || mode == "bundler" {
			continue
		}
		diagnostics = append(diagnostics, extractor.Diagnostic{
			Severity: extractor.DiagnosticWarning,
			Message:  fmt.Sprintf("TypeScript moduleResolution %q in %q is unsupported", config.CompilerOptions.ModuleResolution, configPath),
		})
	}
	return diagnostics
}

func nearestTSConfig(sourcePath string, view extractor.ResolverFileView) (string, tsConfig, bool) {
	projectRoot := view.ProjectRoot()
	if projectRoot == "" {
		return "", tsConfig{}, false
	}
	for directory := path.Dir(sourcePath); ; directory = path.Dir(directory) {
		configPath := path.Join(directory, "tsconfig.json")
		if contents, found := view.File(configPath); found {
			var config tsConfig
			if err := json.Unmarshal(contents, &config); err == nil {
				return configPath, config, true
			}
		}
		if directory == projectRoot || directory == "." {
			break
		}
	}
	return "", tsConfig{}, false
}

func longestMatchingPathPattern(specifier string, paths map[string][]string) (string, string, bool) {
	pattern := ""
	suffix := ""
	for candidate := range paths {
		prefix, found := strings.CutSuffix(candidate, "*")
		if found {
			if !strings.HasPrefix(specifier, prefix) || len(candidate) <= len(pattern) {
				continue
			}
			pattern = candidate
			suffix = strings.TrimPrefix(specifier, prefix)
			continue
		}
		if candidate == specifier && len(candidate) > len(pattern) {
			pattern = candidate
			suffix = ""
		}
	}
	return pattern, suffix, pattern != ""
}

type packageManifest struct {
	Exports json.RawMessage `json:"exports"`
	Main    string          `json:"main"`
}

func resolvePackageSpecifier(sourcePath, specifier string, files map[string]graph.Node, view extractor.ResolverFileView) (string, bool) {
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
					if target, found := selectPackageExport(manifest.Exports, subpath); found {
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

func selectPackageExport(raw json.RawMessage, subpath string) (string, bool) {
	var target string
	if err := json.Unmarshal(raw, &target); err == nil {
		return target, true
	}

	var values map[string]json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return "", false
	}
	if subpath != "" {
		return selectPackageExport(values["./"+subpath], "")
	}
	if root, found := values["."]; found {
		return selectPackageExport(root, "")
	}
	for _, condition := range []string{"import", "default"} {
		if candidate, found := values[condition]; found {
			return selectPackageExport(candidate, "")
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
	for _, extension := range []string{".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"} {
		candidates = append(candidates, base+extension)
	}
	for _, extension := range []string{".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"} {
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
