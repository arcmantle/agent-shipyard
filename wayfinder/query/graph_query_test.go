package query_test

import (
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"agent-wayfinder/query"
)

func TestParseGraphQueryParsesNodeLookup(t *testing.T) {
	parsed, err := query.ParseGraphQuery(`MATCH (node:Function {name: "main"}) RETURN node.name ORDER BY node.name ASC LIMIT 1`)
	if err != nil {
		t.Fatalf("parse graph query: %v", err)
	}
	if len(parsed.Match.Nodes) != 1 || len(parsed.Match.Relationships) != 0 || parsed.Match.Nodes[0].Label != "Function" || parsed.Match.Nodes[0].Properties[0].Value != "main" || parsed.Limit != 1 {
		t.Errorf("match = %+v, want one Function node named main", parsed.Match)
	}
}

func TestValidateGraphQueryResolvesSchemaReferences(t *testing.T) {
	schema := query.GraphQuerySchema{
		NodeKinds: map[string][]string{
			"Function": {"name", "qualifiedName", "exported"},
			"File":     {"path"},
		},
		RelationshipTypes: map[string][]string{"calls": {"confidence"}},
	}
	for _, testCase := range []struct {
		name    string
		source  string
		wantErr string
	}{
		{name: "known references", source: `MATCH (source:Function {exported: true})-[call:calls]->(target:Function) WHERE target.name = "main" AND call.confidence = "extracted" RETURN source, call, target.qualifiedName ORDER BY target.name LIMIT 10`},
		{name: "unknown node kind", source: `MATCH (node:Class) RETURN node LIMIT 1`, wantErr: "Class"},
		{name: "anonymous patterns", source: `MATCH (source)-[:calls]->(:Function {name: "main"}) RETURN source LIMIT 1`},
		{name: "repeated node binding", source: `MATCH (node)-[:calls]->(node:Function) RETURN node.name LIMIT 1`},
		{name: "unknown relation", source: `MATCH (source)-[:imports]->(target) RETURN target LIMIT 1`, wantErr: "imports"},
		{name: "unknown inline property", source: `MATCH (node:Function {path: "main.go"}) RETURN node LIMIT 1`, wantErr: "path"},
		{name: "unknown WHERE property", source: `MATCH (node:File) WHERE node.name = "main" RETURN node LIMIT 1`, wantErr: "name"},
		{name: "unknown RETURN property", source: `MATCH (node) RETURN node.missing LIMIT 1`, wantErr: "missing"},
		{name: "unknown ORDER property", source: `MATCH (node:Function) RETURN node ORDER BY node.path LIMIT 1`, wantErr: "path"},
		{name: "unknown relationship property", source: `MATCH (source)-[call:calls]->(target) RETURN call.name LIMIT 1`, wantErr: "name"},
		{name: "unbound WHERE alias", source: `MATCH (node) WHERE missing.name = "main" RETURN node LIMIT 1`, wantErr: "missing"},
		{name: "unbound RETURN alias", source: `MATCH (node) RETURN missing LIMIT 1`, wantErr: "missing"},
		{name: "unbound ORDER alias", source: `MATCH (node) RETURN node ORDER BY missing LIMIT 1`, wantErr: "missing"},
		{name: "conflicting node kinds", source: `MATCH (node:Function)-[:calls]->(node:File) RETURN node LIMIT 1`, wantErr: "node"},
		{name: "node relation alias collision", source: `MATCH (node)-[node:calls]->(target) RETURN target LIMIT 1`, wantErr: "node"},
		{name: "reused relation alias", source: `MATCH (source)-[call:calls]->(middle)-[call:calls]->(target) RETURN target LIMIT 1`, wantErr: "call"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			parsed, err := query.ParseGraphQuery(testCase.source)
			if err != nil {
				t.Fatal(err)
			}
			validated, err := query.ValidateGraphQuery(parsed, schema, query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 10})
			if testCase.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
					t.Fatalf("validation error = %v, want %q", err, testCase.wantErr)
				}
				return
			}
			if err != nil || !reflect.DeepEqual(validated, parsed) {
				t.Fatalf("validation = %+v, %v, want unchanged query", validated, err)
			}
		})
	}
}

func TestParseGraphQueryParsesCypherLiteralsAndEscapedIdentifiers(t *testing.T) {
	parsed, err := query.ParseGraphQuery("MATCH (node:`go:function` {name: 'owner\\'s \\u0061pi'}) RETURN node LIMIT 1")
	if err != nil {
		t.Fatalf("parse graph query: %v", err)
	}
	if parsed.Match.Nodes[0].Label != "go:function" || parsed.Match.Nodes[0].Properties[0].Value != "owner's api" {
		t.Errorf("node = %+v, want escaped label and decoded string", parsed.Match.Nodes[0])
	}
}

func TestValidateGraphQueryBoundsAndResourceCaps(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		source    string
		limits    query.GraphQueryLimits
		wantLimit int
		wantErr   string
	}{
		{name: "cap results", source: `MATCH (node) RETURN node LIMIT 1000`, limits: query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 7}, wantLimit: 7},
		{name: "zero depth lookup", source: `MATCH (node) RETURN node LIMIT 1`, limits: query.GraphQueryLimits{MaxDepth: 0, MaxNodes: 7}, wantLimit: 1},
		{name: "default path", source: `MATCH (source)-[:calls*]->(target) RETURN target LIMIT 1`, limits: query.GraphQueryLimits{MaxDepth: 3, MaxNodes: 7}, wantLimit: 1},
		{name: "maximum path", source: `MATCH (source)-[:calls*1..5]->(target) RETURN target LIMIT 1`, limits: query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 7}, wantLimit: 1},
		{name: "chained path at cap", source: `MATCH (source)-[:calls*2]->(middle)-[:calls*3]->(target) RETURN target LIMIT 1`, limits: query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 7}, wantLimit: 1},
		{name: "zero limit", source: `MATCH (node) RETURN node LIMIT 0`, limits: query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 7}, wantErr: "LIMIT"},
		{name: "zero minimum hops", source: `MATCH (source)-[:calls*0..3]->(target) RETURN target LIMIT 1`, limits: query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 7}, wantErr: "path"},
		{name: "too many hops", source: `MATCH (source)-[:calls*1..6]->(target) RETURN target LIMIT 1`, limits: query.GraphQueryLimits{MaxDepth: 10, MaxNodes: 7}, wantErr: "path"},
		{name: "reversed bounds", source: `MATCH (source)-[:calls*3..1]->(target) RETURN target LIMIT 1`, limits: query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 7}, wantErr: "path"},
		{name: "depth cap", source: `MATCH (source)-[:calls*1..3]->(target) RETURN target LIMIT 1`, limits: query.GraphQueryLimits{MaxDepth: 2, MaxNodes: 7}, wantErr: "depth"},
		{name: "combined depth cap", source: `MATCH (source)-[:calls*3]->(middle)-[:calls*3]->(target) RETURN target LIMIT 1`, limits: query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 7}, wantErr: "depth"},
		{name: "negative depth cap", source: `MATCH (node) RETURN node LIMIT 1`, limits: query.GraphQueryLimits{MaxDepth: -1, MaxNodes: 7}, wantErr: "limits"},
		{name: "zero node cap", source: `MATCH (node) RETURN node LIMIT 1`, limits: query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 0}, wantErr: "limits"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			parsed, err := query.ParseGraphQuery(testCase.source)
			if err != nil {
				t.Fatal(err)
			}
			original := parsed.Limit
			validated, err := query.ValidateGraphQuery(parsed, query.GraphQuerySchema{RelationshipTypes: map[string][]string{"calls": nil}}, testCase.limits)
			if testCase.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
					t.Fatalf("validation error = %v, want %q", err, testCase.wantErr)
				}
				return
			}
			if err != nil || validated.Limit != testCase.wantLimit {
				t.Fatalf("validated LIMIT = %d, error = %v, want %d", validated.Limit, err, testCase.wantLimit)
			}
			if parsed.Limit != original || !reflect.DeepEqual(validated.Match, parsed.Match) {
				t.Fatal("validation changed the input AST or path bounds")
			}
		})
	}
}

func TestParseGraphQueryParsesNumericPredicates(t *testing.T) {
	parsed, err := query.ParseGraphQuery(`MATCH (node {offset: -2, score: 0.75}) WHERE node.weight = -1.5 RETURN node LIMIT 1`)
	if err != nil {
		t.Fatalf("parse graph query: %v", err)
	}
	want := []query.PropertyPredicate{{Property: "offset", Value: -2}, {Property: "score", Value: 0.75}}
	if !reflect.DeepEqual(parsed.Match.Nodes[0].Properties, want) || parsed.Where[0].Value != -1.5 {
		t.Errorf("predicates = %+v, %+v, want signed and decimal values", parsed.Match.Nodes[0].Properties, parsed.Where)
	}
}

func TestValidateGraphQuerySearchSources(t *testing.T) {
	schema := query.GraphQuerySchema{
		NodeKinds:         map[string][]string{"Function": {"name"}},
		RelationshipTypes: map[string][]string{"calls": nil},
	}
	for _, testCase := range []struct {
		name    string
		source  string
		wantErr string
	}{
		{name: "lexical lookup", source: `SEARCH LEXICAL "entrypoint" AS seed WHERE seed.name = "main" RETURN seed ORDER BY seed.name LIMIT 1`},
		{name: "vector traversal", source: `SEARCH VECTOR "entrypoint" AS seed MATCH (seed:Function)-[:calls]->(target) RETURN target LIMIT 1`},
		{name: "incoming traversal", source: `SEARCH LEXICAL "entrypoint" AS seed MATCH (caller)<-[:calls]-(seed) RETURN caller LIMIT 1`},
		{name: "unbound search source", source: `SEARCH LEXICAL "main" AS seed MATCH (node) RETURN node LIMIT 1`, wantErr: "seed"},
		{name: "search relation collision", source: `SEARCH LEXICAL "main" AS seed MATCH (node)-[seed:calls]->(target) RETURN target LIMIT 1`, wantErr: "seed"},
		{name: "empty lexical text", source: `SEARCH LEXICAL "" AS seed RETURN seed LIMIT 1`, wantErr: "SEARCH"},
		{name: "blank vector text", source: `SEARCH VECTOR "  " AS seed RETURN seed LIMIT 1`, wantErr: "SEARCH"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			parsed, err := query.ParseGraphQuery(testCase.source)
			if err != nil {
				t.Fatal(err)
			}
			validated, err := query.ValidateGraphQuery(parsed, schema, query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 10})
			if testCase.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
					t.Fatalf("validation error = %v, want %q", err, testCase.wantErr)
				}
				return
			}
			if err != nil || !reflect.DeepEqual(validated, parsed) {
				t.Fatalf("validation = %+v, %v, want unchanged query", validated, err)
			}
		})
	}
}

func TestParseGraphQueryParsesAnonymousPatterns(t *testing.T) {
	parsed, err := query.ParseGraphQuery(`MATCH (caller)-[:calls]->(:Function) RETURN caller LIMIT 10`)
	if err != nil {
		t.Fatalf("parse graph query: %v", err)
	}
	if parsed.Match.Relationships[0].Alias != "" || parsed.Match.Relationships[0].Type != "calls" || parsed.Match.Relationships[0].MinHops != 1 || parsed.Match.Relationships[0].MaxHops != 1 || parsed.Match.Nodes[1].Alias != "" || parsed.Match.Nodes[1].Label != "Function" {
		t.Errorf("match = %+v, want anonymous calls relationship and Function node", parsed.Match)
	}
}

func TestValidateGraphQueryRejectsMalformedAST(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		change  func(*query.GraphQuery)
		wantErr string
	}{
		{name: "missing source", change: func(parsed *query.GraphQuery) { parsed.Match.Nodes = nil }, wantErr: "source"},
		{name: "missing relationship", change: func(parsed *query.GraphQuery) {
			parsed.Match.Nodes = append(parsed.Match.Nodes, query.NodePattern{Alias: "other"})
		}, wantErr: "MATCH"},
		{name: "missing endpoint", change: func(parsed *query.GraphQuery) {
			parsed.Match.Relationships = []query.RelationshipPattern{{Type: "calls", MinHops: 1, MaxHops: 1}}
		}, wantErr: "MATCH"},
		{name: "missing RETURN", change: func(parsed *query.GraphQuery) { parsed.Return = nil }, wantErr: "RETURN"},
		{name: "empty WHERE property", change: func(parsed *query.GraphQuery) { parsed.Where[0].Property = "" }, wantErr: "property"},
		{name: "inline predicate alias", change: func(parsed *query.GraphQuery) { parsed.Match.Nodes[0].Properties[0].Alias = "other" }, wantErr: "predicate"},
		{name: "null inline value", change: func(parsed *query.GraphQuery) { parsed.Match.Nodes[0].Properties[0].Value = nil }, wantErr: "scalar"},
		{name: "non-scalar WHERE value", change: func(parsed *query.GraphQuery) { parsed.Where[0].Value = []string{"main"} }, wantErr: "scalar"},
		{name: "non-finite value", change: func(parsed *query.GraphQuery) { parsed.Where[0].Value = math.Inf(1) }, wantErr: "scalar"},
		{name: "NaN value", change: func(parsed *query.GraphQuery) { parsed.Where[0].Value = math.NaN() }, wantErr: "scalar"},
		{name: "unsupported search kind", change: func(parsed *query.GraphQuery) {
			parsed.Search = &query.SearchClause{Kind: "SQL", Text: "main", Alias: "node"}
		}, wantErr: "SEARCH"},
		{name: "empty search alias", change: func(parsed *query.GraphQuery) {
			parsed.Search = &query.SearchClause{Kind: query.SearchLexical, Text: "main"}
		}, wantErr: "SEARCH"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			parsed, err := query.ParseGraphQuery(`MATCH (node:Function {name: "main"}) WHERE node.name = "main" RETURN node ORDER BY node.name LIMIT 1`)
			if err != nil {
				t.Fatal(err)
			}
			testCase.change(&parsed)
			_, err = query.ValidateGraphQuery(parsed, query.GraphQuerySchema{NodeKinds: map[string][]string{"Function": {"name"}}, RelationshipTypes: map[string][]string{"calls": nil}}, query.GraphQueryLimits{MaxDepth: 5, MaxNodes: 10})
			if err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("validation error = %v, want %q", err, testCase.wantErr)
			}
		})
	}
}

func TestParseGraphQueryParsesExactPredicatesAndBoundedPath(t *testing.T) {
	parsed, err := query.ParseGraphQuery(`
		MATCH (source:Function {exported: true})-[call:calls*1..3]->(target:Function)
		WHERE target.package = "query" AND target.exported = true
		RETURN source, call, target.qualifiedName
		LIMIT 10
	`)
	if err != nil {
		t.Fatalf("parse graph query: %v", err)
	}
	if parsed.Match.Nodes[0].Alias != "source" || parsed.Match.Relationships[0].Alias != "call" || parsed.Match.Relationships[0].Type != "calls" || parsed.Match.Nodes[1].Alias != "target" || parsed.Limit != 10 {
		t.Errorf("query = %+v, want source-[call:calls]->target with LIMIT 10", parsed)
	}
	if got, want := parsed.Match.Nodes[0].Properties[0], (query.PropertyPredicate{Property: "exported", Value: true}); got != want {
		t.Errorf("source predicate = %+v, want %+v", got, want)
	}
	if got, want := parsed.Match.Relationships[0].MinHops, 1; got != want {
		t.Errorf("minimum hops = %d, want %d", got, want)
	}
	if got, want := parsed.Match.Relationships[0].MaxHops, 3; got != want {
		t.Errorf("maximum hops = %d, want %d", got, want)
	}
	if got, want := parsed.Where[0], (query.PropertyPredicate{Alias: "target", Property: "package", Value: "query"}); got != want {
		t.Errorf("WHERE predicate = %+v, want %+v", got, want)
	}
	if got, want := parsed.Where[1], (query.PropertyPredicate{Alias: "target", Property: "exported", Value: true}); got != want {
		t.Errorf("WHERE predicate = %+v, want %+v", got, want)
	}
	if got, want := parsed.Return[2], (query.Projection{Alias: "target", Property: "qualifiedName"}); got != want {
		t.Errorf("projection = %+v, want %+v", got, want)
	}
}

func TestParseGraphQueryDefaultsVariablePathBounds(t *testing.T) {
	parsed, err := query.ParseGraphQuery(`
		MATCH (source)-[call:calls*]->(target)
		RETURN source, target
		LIMIT 10
	`)
	if err != nil {
		t.Fatalf("parse graph query: %v", err)
	}
	if got, want := parsed.Match.Relationships[0].MinHops, 1; got != want {
		t.Errorf("minimum hops = %d, want %d", got, want)
	}
	if got, want := parsed.Match.Relationships[0].MaxHops, 3; got != want {
		t.Errorf("maximum hops = %d, want %d", got, want)
	}
}

func TestParseGraphQueryParsesSearchAndOrder(t *testing.T) {
	parsed, err := query.ParseGraphQuery(`
		SEARCH LEXICAL "entrypoint" AS seed
		MATCH (seed)-[call:calls]->(target:Function)
		RETURN target
		ORDER BY target.qualifiedName DESC
		LIMIT 5
	`)
	if err != nil {
		t.Fatalf("parse graph query: %v", err)
	}
	if got, want := parsed.Search, (&query.SearchClause{Kind: query.SearchLexical, Text: "entrypoint", Alias: "seed"}); *got != *want {
		t.Errorf("search = %+v, want %+v", got, want)
	}
	if got, want := parsed.OrderBy[0], (query.OrderTerm{Projection: query.Projection{Alias: "target", Property: "qualifiedName"}, Descending: true}); got != want {
		t.Errorf("order term = %+v, want %+v", got, want)
	}
}

func TestParseGraphQueryParsesSearchWithoutTraversal(t *testing.T) {
	parsed, err := query.ParseGraphQuery(`SEARCH VECTOR "entrypoint" AS seed RETURN seed ORDER BY seed.name LIMIT 5`)
	if err != nil {
		t.Fatalf("parse graph query: %v", err)
	}
	if parsed.Search == nil || parsed.Search.Kind != query.SearchVector || parsed.Search.Alias != "seed" || len(parsed.Match.Nodes) != 0 {
		t.Errorf("query = %+v, want VECTOR source without traversal", parsed)
	}
}

func TestParseGraphQueryParsesChainedPathsAndOrdering(t *testing.T) {
	parsed, err := query.ParseGraphQuery(`match (first)-[:calls*2]->(middle)<-[call:calls*1..5]-(last) return first.name, last order by first.name asc, last.name desc limit 10`)
	if err != nil {
		t.Fatalf("parse graph query: %v", err)
	}
	if len(parsed.Match.Nodes) != 3 || len(parsed.Match.Relationships) != 2 || parsed.Match.Nodes[0].Alias != "first" || parsed.Match.Nodes[1].Alias != "middle" || parsed.Match.Nodes[2].Alias != "last" || parsed.Match.Relationships[0].MinHops != 2 || parsed.Match.Relationships[0].MaxHops != 2 || !parsed.Match.Relationships[1].Incoming || parsed.Match.Relationships[1].Alias != "call" || parsed.Match.Relationships[1].MaxHops != 5 {
		t.Errorf("match = %+v, want chained directed bounded paths", parsed.Match)
	}
	want := []query.OrderTerm{{Projection: query.Projection{Alias: "first", Property: "name"}}, {Projection: query.Projection{Alias: "last", Property: "name"}, Descending: true}}
	if !reflect.DeepEqual(parsed.OrderBy, want) {
		t.Errorf("order = %+v, want %+v", parsed.OrderBy, want)
	}
}

func TestParseGraphQueryRejectsUnsupportedOrUnboundedSource(t *testing.T) {
	testCases := map[string]string{
		"empty":                   "",
		"SQL":                     `SELECT * FROM nodes`,
		"delete":                  `MATCH (node) DELETE node RETURN node LIMIT 1`,
		"procedure":               `CALL lookup() RETURN node LIMIT 1`,
		"subquery":                `MATCH (node) WHERE EXISTS { MATCH (other) } RETURN node LIMIT 1`,
		"undirected":              `MATCH (node)-[:calls]-(other) RETURN node LIMIT 1`,
		"open upper bound":        `MATCH (node)-[:calls*1..]->(other) RETURN node LIMIT 1`,
		"invalid predicate":       `MATCH (node) WHERE node.name <> "main" RETURN node LIMIT 1`,
		"unterminated string":     `SEARCH LEXICAL "main`,
		"invalid escape":          `MATCH (node {name: "\q"}) RETURN node LIMIT 1`,
		"unterminated identifier": "MATCH (node:`Function) RETURN node LIMIT 1",
		"empty identifier":        "MATCH (node:``) RETURN node LIMIT 1",
		"multiple statements":     `MATCH (node) RETURN node LIMIT 1 MATCH (other) RETURN other LIMIT 1`,
		"invalid SEARCH kind":     `SEARCH FUZZY "main" AS node RETURN node LIMIT 1`,
		"decimal limit":           `MATCH (node) RETURN node LIMIT 1.5`,
		"limit overflow":          `MATCH (node) RETURN node LIMIT 9999999999999999999999999`,
		"non-ASCII number":        `MATCH (node) RETURN node LIMIT ` + string(rune(0x0661)),
		"write":                   `CREATE (node:Function) RETURN node LIMIT 1`,
		"no limit":                `MATCH (source)-[call:calls]->(target) RETURN target`,
		"unbounded":               `MATCH (source)-[call:calls*..3]->(target) RETURN target LIMIT 1`,
		"aggregation":             `MATCH (source)-[call:calls]->(target) RETURN count(target) LIMIT 1`,
	}
	for name, source := range testCases {
		t.Run(name, func(t *testing.T) {
			_, err := query.ParseGraphQuery(source)
			if err == nil {
				t.Fatal("parse graph query succeeded, want error")
			}
			if !strings.Contains(err.Error(), "parse graph query at character ") {
				t.Errorf("error = %q, want source-position parse error", err)
			}
			if name == "unbounded" && !strings.Contains(err.Error(), "unbounded path") {
				t.Errorf("error = %q, want unbounded path error", err)
			}
		})
	}
}

func TestParseGraphQueryReportsCharacterPositions(t *testing.T) {
	alias := "node" + string(rune(0x00f1))
	prefix := "MATCH (" + alias + ") RETURN " + alias + " LIMIT "
	for _, suffix := range []string{"1 @", "invalid"} {
		t.Run(suffix, func(t *testing.T) {
			source := prefix + suffix
			_, err := query.ParseGraphQuery(source)
			if err == nil {
				t.Fatal("parse graph query succeeded, want error")
			}
			offset := len(prefix)
			if suffix == "1 @" {
				offset += 2
			}
			want := fmt.Sprintf("at character %d:", utf8.RuneCountInString(source[:offset])+1)
			if !strings.Contains(err.Error(), want) {
				t.Errorf("error = %q, want %q", err, want)
			}
		})
	}
}
