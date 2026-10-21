package graph_query

import (
	"fmt"
	"math"
	"slices"
	"strings"
)

type Schema struct {
	NodeKinds         map[string][]string
	RelationshipTypes map[string][]string
}

type Limits struct {
	MaxDepth int
	MaxNodes int
}

func Validate(parsed GraphQuery, schema Schema, limits Limits) (GraphQuery, error) {
	if limits.MaxDepth < 0 || limits.MaxNodes <= 0 {
		return GraphQuery{}, fmt.Errorf("validate graph query: limits require non-negative MaxDepth and positive MaxNodes")
	}
	if parsed.Limit <= 0 {
		return GraphQuery{}, fmt.Errorf("validate graph query: a positive LIMIT is required")
	}
	if len(parsed.Match.Nodes) == 0 && parsed.Search == nil {
		return GraphQuery{}, fmt.Errorf("validate graph query: a MATCH or SEARCH source is required")
	}
	if len(parsed.Match.Nodes) > 0 && len(parsed.Match.Relationships) != len(parsed.Match.Nodes)-1 || len(parsed.Match.Nodes) == 0 && len(parsed.Match.Relationships) != 0 {
		return GraphQuery{}, fmt.Errorf("validate graph query: MATCH requires one relationship between each pair of nodes")
	}
	if len(parsed.Return) == 0 {
		return GraphQuery{}, fmt.Errorf("validate graph query: RETURN requires at least one projection")
	}
	remainingDepth := limits.MaxDepth
	for _, relationship := range parsed.Match.Relationships {
		if relationship.MinHops < 1 || relationship.MaxHops > 5 || relationship.MinHops > relationship.MaxHops {
			return GraphQuery{}, fmt.Errorf("validate graph query: path bounds must satisfy 1 <= minimum <= maximum <= 5")
		}
		if relationship.MaxHops > remainingDepth {
			return GraphQuery{}, fmt.Errorf("validate graph query: path exceeds configured depth cap %d", limits.MaxDepth)
		}
		remainingDepth -= relationship.MaxHops
	}
	validator := semanticValidator{schema: schema, bindings: make(map[string]queryBinding)}
	if parsed.Search != nil {
		if parsed.Search.Kind != SearchLexical && parsed.Search.Kind != SearchVector {
			return GraphQuery{}, fmt.Errorf("validate graph query: unsupported SEARCH kind %q", parsed.Search.Kind)
		}
		if parsed.Search.Alias == "" || strings.TrimSpace(parsed.Search.Text) == "" {
			return GraphQuery{}, fmt.Errorf("validate graph query: SEARCH requires an alias and non-empty text")
		}
		if len(parsed.Match.Nodes) > 0 && !slices.ContainsFunc(parsed.Match.Nodes, func(node NodePattern) bool {
			return node.Alias == parsed.Search.Alias
		}) {
			return GraphQuery{}, fmt.Errorf("validate graph query: SEARCH alias %q is not bound in MATCH", parsed.Search.Alias)
		}
		validator.bindings[parsed.Search.Alias] = queryBinding{}
	}
	for _, node := range parsed.Match.Nodes {
		if node.Label != "" {
			if _, exists := schema.NodeKinds[node.Label]; !exists {
				return GraphQuery{}, fmt.Errorf("validate graph query: unknown node kind %q", node.Label)
			}
		}
		if node.Alias != "" {
			binding := validator.bindings[node.Alias]
			if binding.kind != "" && node.Label != "" && binding.kind != node.Label {
				return GraphQuery{}, fmt.Errorf("validate graph query: conflicting node kinds for alias %q", node.Alias)
			}
			if node.Label != "" {
				binding.kind = node.Label
			}
			validator.bindings[node.Alias] = binding
		}
	}
	for _, relationship := range parsed.Match.Relationships {
		if _, exists := schema.RelationshipTypes[relationship.Type]; !exists {
			return GraphQuery{}, fmt.Errorf("validate graph query: unknown relationship type %q", relationship.Type)
		}
		if relationship.Alias != "" {
			if _, exists := validator.bindings[relationship.Alias]; exists {
				return GraphQuery{}, fmt.Errorf("validate graph query: duplicate alias %q", relationship.Alias)
			}
			validator.bindings[relationship.Alias] = queryBinding{kind: relationship.Type, relationship: true}
		}
	}
	for _, node := range parsed.Match.Nodes {
		binding := queryBinding{kind: node.Label}
		if node.Alias != "" {
			binding = validator.bindings[node.Alias]
		}
		for _, predicate := range node.Properties {
			if predicate.Alias != "" {
				return GraphQuery{}, fmt.Errorf("validate graph query: inline predicate cannot specify alias %q", predicate.Alias)
			}
			if err := validatePredicateValue(predicate); err != nil {
				return GraphQuery{}, err
			}
			if err := validator.validateProperty(binding, predicate.Property); err != nil {
				return GraphQuery{}, err
			}
		}
	}
	for _, predicate := range parsed.Where {
		if err := validatePredicateValue(predicate); err != nil {
			return GraphQuery{}, err
		}
		if err := validator.validateProjection(Projection{Alias: predicate.Alias, Property: predicate.Property}); err != nil {
			return GraphQuery{}, err
		}
	}
	for _, projection := range parsed.Return {
		if err := validator.validateProjection(projection); err != nil {
			return GraphQuery{}, err
		}
	}
	for _, term := range parsed.OrderBy {
		if err := validator.validateProjection(term.Projection); err != nil {
			return GraphQuery{}, err
		}
	}
	parsed.Limit = min(parsed.Limit, limits.MaxNodes)
	return parsed, nil
}

func validatePredicateValue(predicate PropertyPredicate) error {
	if predicate.Property == "" {
		return fmt.Errorf("validate graph query: predicate requires a property name")
	}
	switch value := predicate.Value.(type) {
	case string, bool, int:
		return nil
	case float64:
		if !math.IsNaN(value) && !math.IsInf(value, 0) {
			return nil
		}
	}
	return fmt.Errorf("validate graph query: property %q requires an exact finite scalar value", predicate.Property)
}

type queryBinding struct {
	kind         string
	relationship bool
}

type semanticValidator struct {
	schema   Schema
	bindings map[string]queryBinding
}

func (validator semanticValidator) validateProjection(projection Projection) error {
	binding, exists := validator.bindings[projection.Alias]
	if !exists {
		return fmt.Errorf("validate graph query: unbound alias %q", projection.Alias)
	}
	if projection.Property == "" {
		return nil
	}
	return validator.validateProperty(binding, projection.Property)
}

func (validator semanticValidator) validateProperty(binding queryBinding, property string) error {
	properties := validator.schema.NodeKinds
	if binding.relationship {
		properties = validator.schema.RelationshipTypes
	}
	if binding.kind != "" {
		if slices.Contains(properties[binding.kind], property) {
			return nil
		}
	} else {
		for _, names := range properties {
			if slices.Contains(names, property) {
				return nil
			}
		}
	}
	return fmt.Errorf("validate graph query: unknown property %q for kind %q", property, binding.kind)
}
