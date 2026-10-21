export type SearchTermExpression = {
	type: "term";
	value: string;
	expansion: "fuzzy" | "strict";
};

export type SearchPhraseExpression = {
	type: "phrase";
	value: string;
	expansion: "strict";
};

export type SearchPrefixExpression = {
	type: "prefix";
	value: string;
	expansion: "strict";
};

export type SearchAndExpression = {
	type: "and";
	operands: SearchExpression[];
};

export type SearchOrExpression = {
	type: "or";
	operands: SearchExpression[];
};

export type SearchNotExpression = {
	type: "not";
	operand: SearchExpression;
};

export type SearchNearOperand = SearchPhraseExpression | (SearchTermExpression & { expansion: "strict" });

export type SearchNearExpression = {
	type: "near";
	left: SearchNearOperand;
	right: SearchNearOperand;
	distance: number;
};

export type SearchExpression =
	| SearchTermExpression
	| SearchPhraseExpression
	| SearchPrefixExpression
	| SearchAndExpression
	| SearchOrExpression
	| SearchNotExpression
	| SearchNearExpression;

export type SearchQuery = {
	source: string;
	expression: SearchExpression;
};

export type SearchQueryParseError = {
	message: string;
	start: number;
	end: number;
};

export type SearchQueryParseFailure = {
	ok: false;
	error: SearchQueryParseError;
};

export type SearchQueryParseResult =
	| { ok: true; query: SearchQuery }
	| SearchQueryParseFailure;

const SEARCH_FILLER_WORDS = new Set([
	"a",
	"an",
	"are",
	"as",
	"at",
	"be",
	"by",
	"do",
	"for",
	"from",
	"how",
	"i",
	"in",
	"is",
	"it",
	"of",
	"on",
	"the",
	"to",
	"was",
	"what",
	"when",
	"where",
	"which",
	"who",
	"with"
]);

export function parseSearchQuery(source: string): SearchQueryParseResult {
		const tokenResult = tokenize(source);
		if (!tokenResult.ok) {
			return tokenResult;
		}

		const tokens = tokenResult.tokens;
		if (tokens.every((token) => token.type === "word")) {
			tokens.splice(0, tokens.length, ...tokens.filter((token) => !SEARCH_FILLER_WORDS.has(token.value!)));
		}
		if (tokens.length === 0) {
			return parseError("Enter a search term.", 0, source.length);
		}

		const state: ParserState = { tokens, index: 0, sourceLength: source.length };
		const expressionResult = parseOrExpression(state);
		if (!expressionResult.ok) {
			return expressionResult;
		}

		const remainingToken = state.tokens[state.index];
		if (remainingToken) {
			return parseError("Unexpected search syntax.", remainingToken.start, remainingToken.end);
		}

	return { ok: true, query: { source, expression: expressionResult.expression } };
}

	function parseOrExpression(state: ParserState): ExpressionResult {
		const operands: SearchExpression[] = [];
		const firstResult = parseAndExpression(state);
		if (!firstResult.ok) {
			return firstResult;
		}
		operands.push(firstResult.expression);

		while (consume(state, "or")) {
			const nextResult = parseAndExpression(state);
			if (!nextResult.ok) {
				return nextResult;
			}
			operands.push(nextResult.expression);
		}

		return { ok: true, expression: joinExpressions("or", operands) };
	}

	function parseAndExpression(state: ParserState): ExpressionResult {
		const operands: SearchExpression[] = [];
		const firstResult = parseUnaryExpression(state);
		if (!firstResult.ok) {
			return firstResult;
		}
		operands.push(firstResult.expression);

		while (true) {
			if (consume(state, "and")) {
				const nextResult = parseUnaryExpression(state);
				if (!nextResult.ok) {
					return nextResult;
				}
				operands.push(nextResult.expression);
				continue;
			}

			if (!canStartUnaryExpression(state.tokens[state.index])) {
				break;
			}
			const nextResult = parseUnaryExpression(state);
			if (!nextResult.ok) {
				return nextResult;
			}
			operands.push(nextResult.expression);
		}

		return { ok: true, expression: joinExpressions("and", operands) };
	}

	function parseUnaryExpression(state: ParserState): ExpressionResult {
		if (consume(state, "not") || consume(state, "minus")) {
			const operandResult = parseUnaryExpression(state);
			if (!operandResult.ok) {
				return operandResult;
			}
			return { ok: true, expression: { type: "not", operand: makeStrict(operandResult.expression) } };
		}
		return parseNearExpression(state);
	}

	function parseNearExpression(state: ParserState): ExpressionResult {
		const leftResult = parsePrimaryExpression(state);
		if (!leftResult.ok) {
			return leftResult;
		}

		const nearToken = state.tokens[state.index];
		if (nearToken?.type !== "near") {
			return leftResult;
		}
		state.index += 1;

		const left = asNearOperand(leftResult.expression);
		if (!left) {
			return parseError("NEAR requires a term or quoted phrase on the left.", nearToken.start, nearToken.end);
		}

		let distance = 10;
		if (consume(state, "slash")) {
			const distanceToken = state.tokens[state.index];
			if (!distanceToken) {
				return parseError("NEAR distance must be an integer from 1 through 100.", state.sourceLength, state.sourceLength);
			}
			if (distanceToken.type !== "word" || !/^\d+$/u.test(distanceToken.value!)) {
				return parseError("NEAR distance must be an integer from 1 through 100.", distanceToken.start, distanceToken.end);
			}
			distance = Number(distanceToken.value);
			if (distance < 1 || distance > 100) {
				return parseError("NEAR distance must be an integer from 1 through 100.", distanceToken.start, distanceToken.end);
			}
			state.index += 1;
		}

		const rightResult = parsePrimaryExpression(state);
		if (!rightResult.ok) {
			return rightResult;
		}
		const right = asNearOperand(rightResult.expression);
		if (!right) {
			return parseError("NEAR requires a term or quoted phrase on the right.", nearToken.start, nearToken.end);
		}

		return { ok: true, expression: { type: "near", left, right, distance } };
	}

	function parsePrimaryExpression(state: ParserState): ExpressionResult {
		const token = state.tokens[state.index];
		if (!token) {
			return parseError("Expected a search term.", state.sourceLength, state.sourceLength);
		}

		if (token.type === "word") {
			state.index += 1;
			if (consume(state, "prefix")) {
				return { ok: true, expression: { type: "prefix", value: token.value!, expansion: "strict" } };
			}
			return { ok: true, expression: { type: "term", value: token.value!, expansion: "fuzzy" } };
		}
		if (token.type === "phrase") {
			state.index += 1;
			return { ok: true, expression: { type: "phrase", value: token.value!, expansion: "strict" } };
		}
		if (consume(state, "open-parenthesis")) {
			const expressionResult = parseOrExpression(state);
			if (!expressionResult.ok) {
				return expressionResult;
			}
			if (!consume(state, "close-parenthesis")) {
				return parseError("Expected a closing parenthesis.", token.start, token.end);
			}
			return expressionResult;
		}

		return parseError("Expected a search term.", token.start, token.end);
	}

	function makeStrict(expression: SearchExpression): SearchExpression {
		if (expression.type === "term") {
			return { ...expression, expansion: "strict" };
		}
		if (expression.type === "and" || expression.type === "or") {
			return { ...expression, operands: expression.operands.map(makeStrict) };
		}
		if (expression.type === "not") {
			return { ...expression, operand: makeStrict(expression.operand) };
		}
		return expression;
	}

	function asNearOperand(expression: SearchExpression): SearchNearOperand | undefined {
		if (expression.type === "phrase") {
			return expression;
		}
		if (expression.type === "term") {
			return { ...expression, expansion: "strict" };
		}
		return undefined;
	}

	function joinExpressions(type: "and" | "or", operands: SearchExpression[]): SearchExpression {
		if (operands.length === 1) {
			return operands[0]!;
		}
		return { type, operands };
	}

	function canStartUnaryExpression(token: SearchToken | undefined): boolean {
		return token?.type === "word" || token?.type === "phrase" || token?.type === "open-parenthesis" || token?.type === "not" || token?.type === "minus";
	}

	function consume(state: ParserState, type: SearchTokenType): boolean {
		if (state.tokens[state.index]?.type !== type) {
			return false;
		}
		state.index += 1;
		return true;
	}

	function tokenize(source: string): TokenizeResult {
		const tokens: SearchToken[] = [];
		let index = 0;
		while (index < source.length) {
			const character = source[index]!;
			if (/\s/u.test(character)) {
				index += 1;
				continue;
			}
			if (character === '"') {
				const end = source.indexOf('"', index + 1);
				if (end === -1) {
					return parseError("Expected a closing quote.", index, source.length);
				}
				const value = normalizePhrase(source.slice(index + 1, end));
				if (value.length === 0) {
					return parseError("A phrase must contain text.", index, end + 1);
				}
				tokens.push({ type: "phrase", value, start: index, end: end + 1 });
				index = end + 1;
				continue;
			}
			if (character === "(") {
				tokens.push({ type: "open-parenthesis", start: index, end: index + 1 });
				index += 1;
				continue;
			}
			if (character === ")") {
				tokens.push({ type: "close-parenthesis", start: index, end: index + 1 });
				index += 1;
				continue;
			}
			if (character === "*") {
				tokens.push({ type: "prefix", start: index, end: index + 1 });
				index += 1;
				continue;
			}
			if (character === "/") {
				tokens.push({ type: "slash", start: index, end: index + 1 });
				index += 1;
				continue;
			}
			if (character === "-" && isNegationPrefix(source, index)) {
				tokens.push({ type: "minus", start: index, end: index + 1 });
				index += 1;
				continue;
			}
			if (/[\p{L}\p{N}_-]/u.test(character)) {
				const start = index;
				while (index < source.length && /[\p{L}\p{N}_-]/u.test(source[index]!)) {
					index += 1;
				}
				const value = normalizeTerm(source.slice(start, index));
				if (value.length > 0) {
					tokens.push({ type: classifyWord(value), value, start, end: index });
				}
				continue;
			}
			index += 1;
		}
		return { ok: true, tokens };
	}

	function normalizeTerm(value: string): string {
		return value
			.normalize("NFKD")
			.replace(/\p{M}/gu, "")
			.toLocaleLowerCase()
			.replace(/[_-]/gu, "");
	}

	function normalizePhrase(value: string): string {
		return (value
			.normalize("NFKD")
			.replace(/\p{M}/gu, "")
			.toLocaleLowerCase()
			.match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
	}

	function classifyWord(value: string): SearchTokenType {
		if (value === "and" || value === "or" || value === "not" || value === "near") {
			return value;
		}
		return "word";
	}

	function isNegationPrefix(source: string, index: number): boolean {
		return index === 0 || /[\s(]/u.test(source[index - 1]!);
	}

	function parseError(message: string, start: number, end: number): SearchQueryParseFailure {
		return { ok: false, error: { message, start, end } };
	}

	type SearchTokenType = "word" | "phrase" | "and" | "or" | "not" | "near" | "minus" | "open-parenthesis" | "close-parenthesis" | "prefix" | "slash";

	type SearchToken = {
		type: SearchTokenType;
		value?: string;
		start: number;
		end: number;
	};

	type ParserState = {
		tokens: SearchToken[];
		index: number;
		sourceLength: number;
	};

	type ExpressionResult =
		| { ok: true; expression: SearchExpression }
		| SearchQueryParseFailure;

	type TokenizeResult =
		| { ok: true; tokens: SearchToken[] }
		| SearchQueryParseFailure;