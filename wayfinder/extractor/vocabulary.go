package extractor

import (
	"fmt"
	"strings"

	"agent-wayfinder/graph"
)

func NewLanguageVocabulary(name string, declarationKinds []graph.NodeKind) (graph.Vocabulary, error) {
	if name == "" {
		return graph.Vocabulary{}, fmt.Errorf("extractor name is empty")
	}

	nodeKinds := []graph.NodeKind{"project", "file", "symbol"}
	for _, kind := range declarationKinds {
		if !strings.HasPrefix(string(kind), name+":") {
			return graph.Vocabulary{}, fmt.Errorf("extractor %q declaration kind %q must use the %q prefix", name, kind, name+":")
		}
		nodeKinds = append(nodeKinds, kind)
	}

	declarationEndpoints := make([]graph.EndpointRule, 0, len(declarationKinds)+len(declarationKinds)*len(declarationKinds))
	for _, kind := range declarationKinds {
		declarationEndpoints = append(declarationEndpoints, graph.EndpointRule{Source: "file", Target: kind})
	}
	for _, source := range declarationKinds {
		for _, target := range declarationKinds {
			declarationEndpoints = append(declarationEndpoints, graph.EndpointRule{Source: source, Target: target})
		}
	}

	return graph.NewVocabulary(graph.VocabularyDefinition{
		NodeKinds: nodeKinds,
		Relations: []graph.RelationDefinition{
			{
				Kind:      "contains",
				Endpoints: []graph.EndpointRule{{Source: "project", Target: "file"}},
			},
			{
				Kind:      "defines",
				Endpoints: declarationEndpoints,
			},
			{
				Kind:      "references",
				Endpoints: declarationEndpoints,
			},
			{
				Kind:      graph.RelationKind(name + ":calls"),
				Endpoints: declarationEndpoints,
			},
		},
	})
}
