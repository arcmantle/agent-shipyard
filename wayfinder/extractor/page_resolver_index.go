package extractor

import (
	"context"

	"agent-wayfinder/graph"
)

type pageResolverTargetResult struct {
	target ResolverTarget
	found  bool
	err    error
}

type pageResolverPackageResult struct {
	targets []ResolverTarget
	err     error
}

type pageResolverIndex struct {
	ResolverIndex
	targets  map[ResolverTargetRequest]pageResolverTargetResult
	packages map[ResolverPackagePageRequest]pageResolverPackageResult
}

func NewPageResolverIndex(index ResolverIndex) ResolverIndex {
	return &pageResolverIndex{
		ResolverIndex: index,
		targets:       make(map[ResolverTargetRequest]pageResolverTargetResult),
		packages:      make(map[ResolverPackagePageRequest]pageResolverPackageResult),
	}
}

func (index *pageResolverIndex) ResolverTarget(ctx context.Context, request ResolverTargetRequest) (ResolverTarget, bool, error) {
	result, ok := index.targets[request]
	if !ok {
		target, found, err := index.ResolverIndex.ResolverTarget(ctx, request)
		result = pageResolverTargetResult{target: cloneResolverTarget(target), found: found, err: err}
		index.targets[request] = result
	}
	return cloneResolverTarget(result.target), result.found, result.err
}

func (index *pageResolverIndex) ResolverPackagePage(ctx context.Context, request ResolverPackagePageRequest) ([]ResolverTarget, error) {
	result, ok := index.packages[request]
	if !ok {
		targets, err := index.ResolverIndex.ResolverPackagePage(ctx, request)
		result = pageResolverPackageResult{targets: cloneResolverTargets(targets), err: err}
		index.packages[request] = result
	}
	return cloneResolverTargets(result.targets), result.err
}

func cloneResolverTargets(targets []ResolverTarget) []ResolverTarget {
	if targets == nil {
		return nil
	}
	cloned := make([]ResolverTarget, len(targets))
	for position, target := range targets {
		cloned[position] = cloneResolverTarget(target)
	}
	return cloned
}

func cloneResolverTarget(target ResolverTarget) ResolverTarget {
	target.Metadata.Extensions = append([]string(nil), target.Metadata.Extensions...)
	target.Nodes = append([]graph.Node(nil), target.Nodes...)
	target.UnresolvedReferences = cloneUnresolvedReferences(target.UnresolvedReferences)
	target.SymbolReferences = append([]SymbolReference(nil), target.SymbolReferences...)
	target.ExportedSurfaces = append([]ExportedSurface(nil), target.ExportedSurfaces...)
	target.Diagnostics = append([]Diagnostic(nil), target.Diagnostics...)
	return target
}

func cloneUnresolvedReferences(references []UnresolvedReference) []UnresolvedReference {
	cloned := append([]UnresolvedReference(nil), references...)
	for position := range cloned {
		cloned[position].Bindings = append([]ModuleBinding(nil), cloned[position].Bindings...)
	}
	return cloned
}
