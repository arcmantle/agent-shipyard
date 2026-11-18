package index

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"agent-wayfinder/extractor"
	csharp "agent-wayfinder/extractors/csharp"
	"agent-wayfinder/graph"
	"agent-wayfinder/storage"
	"agent-wayfinder/workspace"
)

const csharpLanguage = "csharp"

// csharpProjectFileChanged reports whether a changed path can alter C# project
// roots, source ownership, or project references.
func csharpProjectFileChanged(paths []string) bool {
	for _, changedPath := range paths {
		switch strings.ToLower(filepath.Ext(changedPath)) {
		case ".csproj", ".sln":
			return true
		}
	}
	return false
}

// allCSharpPaths lists every discovered C# source. A project-file change can
// move a source to another owner or change what a project can see, so every C#
// source is resolved again.
func allCSharpPaths(discovered []workspace.Source) []string {
	var paths []string
	for _, source := range discovered {
		if strings.EqualFold(filepath.Ext(source.Path), ".cs") {
			paths = append(paths, source.Path)
		}
	}
	return paths
}

// csharpAddedDeclarationPaths lists the unchanged C# sources that reference a
// name a changed source newly declares or no longer declares. Such a source may now resolve a
// reference it left unresolved, or resolve it to a different declaration, yet
// it has no recorded dependency on the changed file. Only the changed
// projects and the projects that reach them through project references are
// searched.
func csharpAddedDeclarationPaths(ctx context.Context, root string, store resolverStore, snapshot storage.Snapshot, discovered []workspace.Source, changed []extractedSource) ([]string, error) {
	changedPaths := make(map[string]struct{}, len(changed))
	addedNames := make(map[string]struct{})
	changedProjects := make(map[string]struct{})
	var knownProjects []string
	seenProjects := make(map[string]struct{})
	for _, source := range discovered {
		if _, seen := seenProjects[source.ProjectID]; !seen && strings.EqualFold(filepath.Ext(source.Path), ".cs") {
			seenProjects[source.ProjectID] = struct{}{}
			knownProjects = append(knownProjects, source.ProjectID)
		}
	}
	for _, source := range changed {
		sourcePath := source.contribution.SourcePath()
		changedPaths[sourcePath] = struct{}{}
		if source.language != csharpLanguage {
			continue
		}
		// A deleted source has no project in discovery any more; the store
		// knows which project held it.
		candidates := []string{source.projectID}
		if source.projectID == "" {
			candidates = knownProjects
		}
		previousNames := make(map[string]struct{})
		projectID := source.projectID
		for _, candidate := range candidates {
			previous, found, err := store.ResolverTarget(ctx, snapshot, extractor.ResolverTargetRequest{ProjectID: candidate, Language: csharpLanguage, SourcePath: sourcePath})
			if err != nil {
				return nil, fmt.Errorf("read previous C# declarations: %w", err)
			}
			if !found {
				continue
			}
			projectID = candidate
			for _, node := range previous.Nodes {
				if name, declared := csharpDeclaredName(node.Kind, node.QualifiedName, node.Evidence.Span.Path); declared {
					previousNames[name] = struct{}{}
				}
			}
			break
		}
		currentNames := make(map[string]struct{})
		for _, node := range source.contribution.Facts().Nodes {
			if name, declared := csharpDeclaredName(node.Kind, node.QualifiedName, node.Evidence.Span.Path); declared {
				currentNames[name] = struct{}{}
			}
		}
		// A new name can resolve or shadow a reference. A removed name can end
		// the ambiguity that left a reference unresolved.
		for name := range currentNames {
			if _, existed := previousNames[name]; !existed {
				addedNames[lastNameSegment(name)] = struct{}{}
				changedProjects[projectID] = struct{}{}
			}
		}
		for name := range previousNames {
			if _, remains := currentNames[name]; !remains {
				addedNames[lastNameSegment(name)] = struct{}{}
				changedProjects[projectID] = struct{}{}
			}
		}
	}
	if len(addedNames) == 0 {
		return nil, nil
	}

	projects := make(map[string]struct{})
	for _, source := range discovered {
		if !strings.EqualFold(filepath.Ext(source.Path), ".cs") {
			continue
		}
		if _, changedProject := changedProjects[source.ProjectID]; changedProject {
			projects[source.ProjectID] = struct{}{}
			continue
		}
		if _, seen := projects[source.ProjectID]; seen {
			continue
		}
		for _, referenced := range workspace.CSharpReferencedProjects(root, source.ProjectID) {
			if _, changedProject := changedProjects[referenced]; changedProject {
				projects[source.ProjectID] = struct{}{}
				break
			}
		}
	}
	projectIDs := make([]string, 0, len(projects))
	for projectID := range projects {
		projectIDs = append(projectIDs, projectID)
	}
	sort.Strings(projectIDs)

	affected := make(map[string]struct{})
	for _, projectID := range projectIDs {
		after := ""
		for {
			targets, err := store.ResolverPackagePage(ctx, snapshot, extractor.ResolverPackagePageRequest{
				ProjectID: projectID, Language: csharpLanguage, PackagePath: ".", Recursive: true,
				AfterSourcePath: after, Limit: resolverProjectionPageSize,
			})
			if err != nil {
				return nil, fmt.Errorf("read C# project %q references: %w", projectID, err)
			}
			if len(targets) == 0 {
				break
			}
			for _, target := range targets {
				after = target.SourcePath
				if _, isChanged := changedPaths[target.SourcePath]; !isChanged && referencesAny(target, addedNames) {
					affected[target.SourcePath] = struct{}{}
				}
			}
		}
	}
	return uniqueSortedKeys(affected), nil
}

func referencesAny(target extractor.ResolverTarget, names map[string]struct{}) bool {
	for _, reference := range target.SymbolReferences {
		if _, found := names[lastNameSegment(reference.Target)]; found {
			return true
		}
	}
	for _, reference := range target.UnresolvedReferences {
		if _, found := names[lastNameSegment(reference.Target)]; found {
			return true
		}
	}
	return false
}

// csharpDeclaredName returns the dotted C# name of a namespace, type, or method.
func csharpDeclaredName(kind graph.NodeKind, qualifiedName, sourcePath string) (string, bool) {
	switch kind {
	case csharp.NamespaceNodeKind, csharp.ClassNodeKind, csharp.StructNodeKind, csharp.InterfaceNodeKind, csharp.RecordNodeKind, csharp.EnumNodeKind, csharp.DelegateNodeKind, csharp.MethodNodeKind:
		return strings.TrimPrefix(qualifiedName, sourcePath+"::"), true
	}
	return "", false
}

func lastNameSegment(name string) string {
	if index := strings.LastIndex(name, "."); index >= 0 {
		return name[index+1:]
	}
	return name
}

func uniqueSortedKeys(set map[string]struct{}) []string {
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}
