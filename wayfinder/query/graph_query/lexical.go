package graph_query

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

type graphQueryTokenKind int

const (
	graphQueryTokenEnd graphQueryTokenKind = iota
	graphQueryTokenIdentifier
	graphQueryTokenQuotedIdentifier
	graphQueryTokenNumber
	graphQueryTokenString
	graphQueryTokenLeftParenthesis
	graphQueryTokenRightParenthesis
	graphQueryTokenLeftBracket
	graphQueryTokenRightBracket
	graphQueryTokenColon
	graphQueryTokenComma
	graphQueryTokenPeriod
	graphQueryTokenDash
	graphQueryTokenGreaterThan
	graphQueryTokenLessThan
	graphQueryTokenLeftBrace
	graphQueryTokenRightBrace
	graphQueryTokenEqual
	graphQueryTokenStar
)

type graphQueryToken struct {
	kind  graphQueryTokenKind
	value string
	index int
}

func tokenizeGraphQuery(source string) ([]graphQueryToken, error) {
	tokens := make([]graphQueryToken, 0)
	for index := 0; index < len(source); {
		character, width := rune(source[index]), 1
		if character >= utf8.RuneSelf {
			character, width = utf8.DecodeRuneInString(source[index:])
		}
		if unicode.IsSpace(character) {
			index += width
			continue
		}
		if character == '_' || unicode.IsLetter(character) {
			start := index
			index += width
			for index < len(source) {
				character, width = rune(source[index]), 1
				if character >= utf8.RuneSelf {
					character, width = utf8.DecodeRuneInString(source[index:])
				}
				if character != '_' && !unicode.IsLetter(character) && !unicode.IsDigit(character) {
					break
				}
				index += width
			}
			tokens = append(tokens, graphQueryToken{kind: graphQueryTokenIdentifier, value: source[start:index], index: start})
			continue
		}
		if character >= '0' && character <= '9' {
			start := index
			for index < len(source) && source[index] >= '0' && source[index] <= '9' {
				index++
			}
			if index+1 < len(source) && source[index] == '.' && source[index+1] >= '0' && source[index+1] <= '9' {
				index++
				for index < len(source) && source[index] >= '0' && source[index] <= '9' {
					index++
				}
			}
			tokens = append(tokens, graphQueryToken{kind: graphQueryTokenNumber, value: source[start:index], index: start})
			continue
		}
		if character == '`' {
			start := index
			index++
			var value strings.Builder
			closed := false
			for index < len(source) {
				if source[index] == '`' {
					index++
					if index < len(source) && source[index] == '`' {
						value.WriteByte('`')
						index++
						continue
					}
					closed = true
					break
				}
				value.WriteByte(source[index])
				index++
			}
			if !closed || value.Len() == 0 {
				return nil, graphQueryError(source, start, "invalid quoted identifier")
			}
			tokens = append(tokens, graphQueryToken{kind: graphQueryTokenQuotedIdentifier, value: value.String(), index: start})
			continue
		}
		if character == '"' || character == '\'' {
			start := index
			quote := source[index]
			index++
			escaped := false
			for index < len(source) {
				if source[index] == quote && !escaped {
					index++
					value, err := decodeGraphQueryString(source[start+1:index-1], quote)
					if err != nil {
						return nil, graphQueryError(source, start, "invalid string")
					}
					tokens = append(tokens, graphQueryToken{kind: graphQueryTokenString, value: value, index: start})
					break
				}
				escaped = source[index] == '\\' && !escaped
				if source[index] != '\\' {
					escaped = false
				}
				index++
			}
			if len(tokens) == 0 || tokens[len(tokens)-1].index != start {
				return nil, graphQueryError(source, start, "unterminated string")
			}
			continue
		}
		kind, found := graphQueryPunctuation[character]
		if !found {
			return nil, graphQueryError(source, index, "unexpected %q", character)
		}
		tokens = append(tokens, graphQueryToken{kind: kind, value: string(character), index: index})
		index += width
	}
	tokens = append(tokens, graphQueryToken{kind: graphQueryTokenEnd, index: len(source)})
	return tokens, nil
}

func graphQueryError(source string, offset int, format string, arguments ...any) error {
	position := utf8.RuneCountInString(source[:offset]) + 1
	return fmt.Errorf("parse graph query at character %d: %s", position, fmt.Sprintf(format, arguments...))
}

func decodeGraphQueryString(source string, quote byte) (string, error) {
	var value strings.Builder
	for len(source) > 0 {
		if source[0] == '\n' || source[0] == '\r' {
			return "", fmt.Errorf("newline in string")
		}
		character, _, remaining, err := strconv.UnquoteChar(source, quote)
		if err != nil {
			return "", err
		}
		value.WriteRune(character)
		source = remaining
	}
	return value.String(), nil
}

var graphQueryPunctuation = map[rune]graphQueryTokenKind{
	'(': graphQueryTokenLeftParenthesis,
	')': graphQueryTokenRightParenthesis,
	'[': graphQueryTokenLeftBracket,
	']': graphQueryTokenRightBracket,
	':': graphQueryTokenColon,
	',': graphQueryTokenComma,
	'.': graphQueryTokenPeriod,
	'-': graphQueryTokenDash,
	'>': graphQueryTokenGreaterThan,
	'<': graphQueryTokenLessThan,
	'{': graphQueryTokenLeftBrace,
	'}': graphQueryTokenRightBrace,
	'=': graphQueryTokenEqual,
	'*': graphQueryTokenStar,
}
