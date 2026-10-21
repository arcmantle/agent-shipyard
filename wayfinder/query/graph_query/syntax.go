package graph_query

import (
	"strconv"
	"strings"
)

const (
	keywordSearch = "SEARCH"
	keywordMatch  = "MATCH"
	keywordWhere  = "WHERE"
	keywordAnd    = "AND"
	keywordReturn = "RETURN"
	keywordOrder  = "ORDER"
	keywordBy     = "BY"
	keywordLimit  = "LIMIT"
	keywordAs     = "AS"
	keywordAsc    = "ASC"
	keywordDesc   = "DESC"
	keywordTrue   = "true"
	keywordFalse  = "false"
)

// GraphQuery is a parsed constrained graph query.
type GraphQuery struct {
	Search  *SearchClause
	Match   MatchClause
	Where   []PropertyPredicate
	Return  []Projection
	OrderBy []OrderTerm
	Limit   int
}

// SearchKind identifies the bounded catalog retrieval source.
type SearchKind string

const (
	SearchLexical SearchKind = "LEXICAL"
	SearchVector  SearchKind = "VECTOR"
)

// SearchClause binds a catalog retrieval result to a MATCH alias.
type SearchClause struct {
	Kind  SearchKind
	Text  string
	Alias string
}

// OrderTerm defines deterministic projection ordering.
type OrderTerm struct {
	Projection Projection
	Descending bool
}

// MatchClause contains one directed path pattern.
type MatchClause struct {
	Nodes         []NodePattern
	Relationships []RelationshipPattern
}

// NodePattern identifies a graph node in a match pattern.
type NodePattern struct {
	Alias      string
	Label      string
	Properties []PropertyPredicate
}

// RelationshipPattern identifies a directed graph relationship.
type RelationshipPattern struct {
	Alias    string
	Type     string
	MinHops  int
	MaxHops  int
	Incoming bool
}

// PropertyPredicate compares an exact scalar property value.
type PropertyPredicate struct {
	Alias    string
	Property string
	Value    any
}

// Projection selects a matched alias or one of its properties.
type Projection struct {
	Alias    string
	Property string
}

// Parse parses a constrained graph-query source string.
func Parse(source string) (GraphQuery, error) {
	parser, err := newGraphQueryParser(source)
	if err != nil {
		return GraphQuery{}, err
	}
	return parser.parse()
}

type graphQueryParser struct {
	source string
	tokens []graphQueryToken
	index  int
}

func newGraphQueryParser(source string) (*graphQueryParser, error) {
	tokens, err := tokenizeGraphQuery(source)
	if err != nil {
		return nil, err
	}
	return &graphQueryParser{source: source, tokens: tokens}, nil
}

func (parser *graphQueryParser) parse() (GraphQuery, error) {
	var search *SearchClause
	if parser.isKeyword(keywordSearch) {
		parsed, err := parser.parseSearch()
		if err != nil {
			return GraphQuery{}, err
		}
		search = &parsed
	}
	var match MatchClause
	if search == nil || parser.isKeyword(keywordMatch) {
		if err := parser.expectKeyword(keywordMatch); err != nil {
			return GraphQuery{}, err
		}
		parsed, err := parser.parseMatch()
		if err != nil {
			return GraphQuery{}, err
		}
		match = parsed
	}
	var where []PropertyPredicate
	if parser.isKeyword(keywordWhere) {
		parser.next()
		for {
			predicate, err := parser.parsePropertyPredicate()
			if err != nil {
				return GraphQuery{}, err
			}
			where = append(where, predicate)
			if !parser.isKeyword(keywordAnd) {
				break
			}
			parser.next()
		}
	}
	if err := parser.expectKeyword(keywordReturn); err != nil {
		return GraphQuery{}, err
	}
	projections, err := parser.parseProjections()
	if err != nil {
		return GraphQuery{}, err
	}
	var orderBy []OrderTerm
	if parser.isKeyword(keywordOrder) {
		parser.next()
		if err := parser.expectKeyword(keywordBy); err != nil {
			return GraphQuery{}, err
		}
		orderBy, err = parser.parseOrderBy()
		if err != nil {
			return GraphQuery{}, err
		}
	}
	if err := parser.expectKeyword(keywordLimit); err != nil {
		return GraphQuery{}, err
	}
	limit, err := parser.parseLimit()
	if err != nil {
		return GraphQuery{}, err
	}
	if parser.current().kind != graphQueryTokenEnd {
		return GraphQuery{}, parser.errorf("unexpected %q after %s", parser.current().value, keywordLimit)
	}
	return GraphQuery{Search: search, Match: match, Where: where, Return: projections, OrderBy: orderBy, Limit: limit}, nil
}

func (parser *graphQueryParser) parseSearch() (SearchClause, error) {
	if err := parser.expectKeyword(keywordSearch); err != nil {
		return SearchClause{}, err
	}
	kind, err := parser.parseIdentifier(keywordSearch + " kind")
	if err != nil {
		return SearchClause{}, err
	}
	searchKind := SearchKind(strings.ToUpper(kind))
	if searchKind != SearchLexical && searchKind != SearchVector {
		return SearchClause{}, parser.errorf("unsupported %s kind %q", keywordSearch, kind)
	}
	if parser.current().kind != graphQueryTokenString {
		return SearchClause{}, parser.errorf("expected %s text", keywordSearch)
	}
	text := parser.current().value
	parser.next()
	if err := parser.expectKeyword(keywordAs); err != nil {
		return SearchClause{}, err
	}
	alias, err := parser.parseIdentifier(keywordSearch + " alias")
	if err != nil {
		return SearchClause{}, err
	}
	return SearchClause{Kind: searchKind, Text: text, Alias: alias}, nil
}

func (parser *graphQueryParser) parseMatch() (MatchClause, error) {
	first, err := parser.parseNode()
	if err != nil {
		return MatchClause{}, err
	}
	match := MatchClause{Nodes: []NodePattern{first}}
	for parser.current().kind == graphQueryTokenDash || parser.current().kind == graphQueryTokenLessThan {
		relationship, err := parser.parseRelationship()
		if err != nil {
			return MatchClause{}, err
		}
		node, err := parser.parseNode()
		if err != nil {
			return MatchClause{}, err
		}
		match.Relationships = append(match.Relationships, relationship)
		match.Nodes = append(match.Nodes, node)
	}
	return match, nil
}

func (parser *graphQueryParser) parseNode() (NodePattern, error) {
	if err := parser.expect(graphQueryTokenLeftParenthesis, "("); err != nil {
		return NodePattern{}, err
	}
	var alias string
	var err error
	if parser.current().kind == graphQueryTokenIdentifier || parser.current().kind == graphQueryTokenQuotedIdentifier {
		alias, err = parser.parseIdentifier("node alias")
		if err != nil {
			return NodePattern{}, err
		}
	}
	node := NodePattern{Alias: alias}
	if parser.current().kind == graphQueryTokenColon {
		parser.next()
		node.Label, err = parser.parseIdentifier("node label")
		if err != nil {
			return NodePattern{}, err
		}
	}
	if parser.current().kind == graphQueryTokenLeftBrace {
		properties, err := parser.parsePropertyMap()
		if err != nil {
			return NodePattern{}, err
		}
		node.Properties = properties
	}
	if err := parser.expect(graphQueryTokenRightParenthesis, ")"); err != nil {
		return NodePattern{}, err
	}
	return node, nil
}

func (parser *graphQueryParser) parseRelationship() (RelationshipPattern, error) {
	incoming := parser.current().kind == graphQueryTokenLessThan
	if incoming {
		parser.next()
	}
	if err := parser.expect(graphQueryTokenDash, "-"); err != nil {
		return RelationshipPattern{}, err
	}
	if err := parser.expect(graphQueryTokenLeftBracket, "["); err != nil {
		return RelationshipPattern{}, err
	}
	var alias string
	if parser.current().kind != graphQueryTokenColon {
		var err error
		alias, err = parser.parseIdentifier("relationship alias")
		if err != nil {
			return RelationshipPattern{}, err
		}
	}
	if err := parser.expect(graphQueryTokenColon, ":"); err != nil {
		return RelationshipPattern{}, err
	}
	relationshipType, err := parser.parseIdentifier("relationship type")
	if err != nil {
		return RelationshipPattern{}, err
	}
	minimumHops, maximumHops, err := parser.parsePathBounds()
	if err != nil {
		return RelationshipPattern{}, err
	}
	if err := parser.expect(graphQueryTokenRightBracket, "]"); err != nil {
		return RelationshipPattern{}, err
	}
	if err := parser.expect(graphQueryTokenDash, "-"); err != nil {
		return RelationshipPattern{}, err
	}
	if !incoming {
		if err := parser.expect(graphQueryTokenGreaterThan, ">"); err != nil {
			return RelationshipPattern{}, err
		}
	}
	return RelationshipPattern{Alias: alias, Type: relationshipType, MinHops: minimumHops, MaxHops: maximumHops, Incoming: incoming}, nil
}

func (parser *graphQueryParser) parsePropertyMap() ([]PropertyPredicate, error) {
	parser.next()
	properties := make([]PropertyPredicate, 0, 1)
	for {
		property, err := parser.parseIdentifier("property name")
		if err != nil {
			return nil, err
		}
		if err := parser.expect(graphQueryTokenColon, ":"); err != nil {
			return nil, err
		}
		value, err := parser.parseValue()
		if err != nil {
			return nil, err
		}
		properties = append(properties, PropertyPredicate{Property: property, Value: value})
		if parser.current().kind != graphQueryTokenComma {
			break
		}
		parser.next()
	}
	if err := parser.expect(graphQueryTokenRightBrace, "}"); err != nil {
		return nil, err
	}
	return properties, nil
}

func (parser *graphQueryParser) parsePropertyPredicate() (PropertyPredicate, error) {
	alias, err := parser.parseIdentifier("predicate alias")
	if err != nil {
		return PropertyPredicate{}, err
	}
	if err := parser.expect(graphQueryTokenPeriod, "."); err != nil {
		return PropertyPredicate{}, err
	}
	property, err := parser.parseIdentifier("predicate property")
	if err != nil {
		return PropertyPredicate{}, err
	}
	if err := parser.expect(graphQueryTokenEqual, "="); err != nil {
		return PropertyPredicate{}, err
	}
	value, err := parser.parseValue()
	if err != nil {
		return PropertyPredicate{}, err
	}
	return PropertyPredicate{Alias: alias, Property: property, Value: value}, nil
}

func (parser *graphQueryParser) parseValue() (any, error) {
	token := parser.current()
	if token.kind == graphQueryTokenDash {
		parser.next()
		if parser.current().kind != graphQueryTokenNumber {
			return nil, parser.errorf("expected numeric value after -")
		}
		token = parser.current()
		token.value = "-" + token.value
	}
	switch token.kind {
	case graphQueryTokenString:
		parser.next()
		return token.value, nil
	case graphQueryTokenNumber:
		if strings.Contains(token.value, ".") {
			value, err := strconv.ParseFloat(token.value, 64)
			if err != nil {
				return nil, parser.errorf("invalid number %q", token.value)
			}
			parser.next()
			return value, nil
		}
		value, err := strconv.Atoi(token.value)
		if err != nil {
			return nil, parser.errorf("invalid number %q", token.value)
		}
		parser.next()
		return value, nil
	case graphQueryTokenIdentifier:
		if strings.EqualFold(token.value, keywordTrue) {
			parser.next()
			return true, nil
		}
		if strings.EqualFold(token.value, keywordFalse) {
			parser.next()
			return false, nil
		}
	}
	return nil, parser.errorf("expected exact scalar value")
}

func (parser *graphQueryParser) parsePathBounds() (int, int, error) {
	if parser.current().kind != graphQueryTokenStar {
		return 1, 1, nil
	}
	parser.next()
	minimumHops, maximumHops := 1, 3
	if parser.current().kind == graphQueryTokenPeriod && parser.index+1 < len(parser.tokens) && parser.tokens[parser.index+1].kind == graphQueryTokenPeriod {
		return 0, 0, parser.errorf("unbounded path is not allowed")
	}
	if parser.current().kind != graphQueryTokenNumber {
		return minimumHops, maximumHops, nil
	}
	value, err := parser.parseLimit()
	if err != nil {
		return 0, 0, err
	}
	minimumHops, maximumHops = value, value
	if parser.current().kind != graphQueryTokenPeriod {
		return minimumHops, maximumHops, nil
	}
	parser.next()
	if err := parser.expect(graphQueryTokenPeriod, "."); err != nil {
		return 0, 0, err
	}
	maximumHops, err = parser.parseLimit()
	if err != nil {
		return 0, 0, err
	}
	return minimumHops, maximumHops, nil
}

func (parser *graphQueryParser) parseProjections() ([]Projection, error) {
	projections := make([]Projection, 0, 1)
	for {
		projection, err := parser.parseProjection()
		if err != nil {
			return nil, err
		}
		projections = append(projections, projection)
		if parser.current().kind != graphQueryTokenComma {
			return projections, nil
		}
		parser.next()
	}
}

func (parser *graphQueryParser) parseOrderBy() ([]OrderTerm, error) {
	terms := make([]OrderTerm, 0, 1)
	for {
		projection, err := parser.parseProjection()
		if err != nil {
			return nil, err
		}
		term := OrderTerm{Projection: projection}
		if parser.isKeyword(keywordAsc) || parser.isKeyword(keywordDesc) {
			term.Descending = parser.isKeyword(keywordDesc)
			parser.next()
		}
		terms = append(terms, term)
		if parser.current().kind != graphQueryTokenComma {
			return terms, nil
		}
		parser.next()
	}
}

func (parser *graphQueryParser) parseProjection() (Projection, error) {
	alias, err := parser.parseIdentifier("projection alias")
	if err != nil {
		return Projection{}, err
	}
	projection := Projection{Alias: alias}
	if parser.current().kind == graphQueryTokenPeriod {
		parser.next()
		projection.Property, err = parser.parseIdentifier("projection property")
		if err != nil {
			return Projection{}, err
		}
	}
	return projection, nil
}

func (parser *graphQueryParser) parseLimit() (int, error) {
	token := parser.current()
	if token.kind != graphQueryTokenNumber {
		return 0, parser.errorf("expected %s value", keywordLimit)
	}
	limit, err := strconv.Atoi(token.value)
	if err != nil {
		return 0, parser.errorf("invalid %s value %q", keywordLimit, token.value)
	}
	parser.next()
	return limit, nil
}

func (parser *graphQueryParser) parseIdentifier(description string) (string, error) {
	token := parser.current()
	if token.kind != graphQueryTokenIdentifier && token.kind != graphQueryTokenQuotedIdentifier {
		return "", parser.errorf("expected %s", description)
	}
	parser.next()
	return token.value, nil
}

func (parser *graphQueryParser) expectKeyword(keyword string) error {
	if !parser.isKeyword(keyword) {
		return parser.errorf("expected %s", keyword)
	}
	parser.next()
	return nil
}

func (parser *graphQueryParser) isKeyword(keyword string) bool {
	token := parser.current()
	return token.kind == graphQueryTokenIdentifier && strings.EqualFold(token.value, keyword)
}

func (parser *graphQueryParser) expect(kind graphQueryTokenKind, description string) error {
	if parser.current().kind != kind {
		return parser.errorf("expected %s", description)
	}
	parser.next()
	return nil
}

func (parser *graphQueryParser) current() graphQueryToken {
	return parser.tokens[parser.index]
}

func (parser *graphQueryParser) next() {
	if parser.current().kind != graphQueryTokenEnd {
		parser.index++
	}
}

func (parser *graphQueryParser) errorf(format string, arguments ...any) error {
	return graphQueryError(parser.source, parser.current().index, format, arguments...)
}
