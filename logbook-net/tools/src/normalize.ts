const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const REFERENCE = /\b[A-Z]+(?:_[A-Z]+)*_[0-9A-HJKMNP-TV-Z]{26}\b/g;
const SHORT_REFERENCE = /\b[A-Z]+(?:_[A-Z]+)*_[0-9A-HJKMNP-TV-Z]{6}\b/g;
const TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g;

/**
 * Creates the approved normalizer for one recording. Each call has its own placeholder numbering,
 * so placeholders follow the order of first appearance in that recording.
 * `literals` maps exact strings (temporary paths, tenant) to placeholders; longer strings are replaced first.
 * Content hashes are not changed: they are deterministic, and a difference is a defect.
 */
export function createNormalizer(literals: Record<string, string> = {}) {
	const tables = new Map<string, Map<string, string>>();
	const ordered = Object.entries(literals)
		.filter(([literal]) => literal.length > 0)
		.sort((a, b) => b[0].length - a[0].length);

	const token = (kind: string, value: string) => {
		let table = tables.get(kind);
		if (!table) tables.set(kind, (table = new Map()));
		let placeholder = table.get(value);
		if (!placeholder) table.set(value, (placeholder = `<${kind}#${table.size + 1}>`));
		return placeholder;
	};

	const normalizeString = (input: string): string => {
		let value = input.replace(/\r\n/g, "\n");
		for (const [literal, placeholder] of ordered) value = value.split(literal).join(placeholder);
		return value
			.replace(TIMESTAMP, "<timestamp>")
			.replace(UUID, (match) => token("uuid", match.toLowerCase()))
			.replace(REFERENCE, (match) => token("ref", match))
			.replace(SHORT_REFERENCE, (match) => token("sref", match));
	};

	const normalize = (value: unknown): unknown => {
		if (typeof value === "string") return normalizeString(value);
		if (Array.isArray(value)) return value.map(normalize);
		if (value && typeof value === "object") {
			const sorted: Record<string, unknown> = {};
			const entries = Object.entries(value).map(([key, item]) => [normalizeString(key), item] as const);
			if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("normalization merges two object keys");
			for (const [key, item] of entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) sorted[key] = normalize(item);
			return sorted;
		}
		return value;
	};

	return normalize;
}
