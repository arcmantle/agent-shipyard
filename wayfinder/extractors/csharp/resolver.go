package csharp

import (
	"context"
	"fmt"

	"agent-wayfinder/extractor"
	"agent-wayfinder/graph"
)

// Resolution holds the cross-source facts C# resolution produces. The minimal
// class contribution has no references to resolve, so it is always empty; later
// issues add import, call, and project-reference resolution.
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

func Resolve(contributions []extractor.Contribution) (Resolution, error) {
	for _, contribution := range contributions {
		if contribution.Metadata().Name != "csharp" {
			return Resolution{}, fmt.Errorf("resolve C#: contribution %q belongs to extractor %q", contribution.SourcePath(), contribution.Metadata().Name)
		}
	}
	return Resolution{}, nil
}

func ResolvePage(ctx context.Context, contributions []extractor.Contribution, projectID string, index extractor.ResolverIndex) (Resolution, error) {
	if projectID == "" || index == nil {
		return Resolution{}, fmt.Errorf("resolve C# page: project and resolver index are required")
	}
	if err := ctx.Err(); err != nil {
		return Resolution{}, err
	}
	return Resolve(contributions)
}
