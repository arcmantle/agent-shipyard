package graphquery

import (
	"fmt"
	"strconv"
	"unicode"
	"unicode/utf8"
)

type graphQueryTokenKind int

const (
	graphQueryTokenEnd graphQueryTokenKind = iota
	graphQueryTokenIdentifier
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
		if unicode.IsDigit(character) {
			start := index
			for index < len(source) && source[index] >= '0' && source[index] <= '9' {
				index++
			}
			tokens = append(tokens, graphQueryToken{kind: graphQueryTokenNumber, value: source[start:index], index: start})
			continue
		}
		if character == '"' {
			start := index
			index++
			escaped := false
			for index < len(source) {
				if source[index] == '"' && !escaped {
					index++
					value, err := strconv.Unquote(source[start:index])
					if err != nil {
						return nil, fmt.Errorf("parse graph query at character %d: invalid string", start+1)
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
				return nil, fmt.Errorf("parse graph query at character %d: unterminated string", start+1)
			}
			continue
		}
		kind, found := graphQueryPunctuation[character]
		if !found {
			return nil, fmt.Errorf("parse graph query at character %d: unexpected %q", index+1, character)
		}
		tokens = append(tokens, graphQueryToken{kind: kind, value: string(character), index: index})
		index += width
	}
	tokens = append(tokens, graphQueryToken{kind: graphQueryTokenEnd, index: len(source)})
	return tokens, nil
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
	'{': graphQueryTokenLeftBrace,
	'}': graphQueryTokenRightBrace,
	'=': graphQueryTokenEqual,
	'*': graphQueryTokenStar,
}
