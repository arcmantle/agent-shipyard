package query

import "agent-wayfinder/graph"

func RelationKinds(relations []string) []graph.RelationKind {
	kinds := make([]graph.RelationKind, len(relations))
	for index, relation := range relations {
		kinds[index] = graph.RelationKind(relation)
	}
	return kinds
}
