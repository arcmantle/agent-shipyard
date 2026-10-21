import { marked } from "marked";

export function toVisibleMarkdownText(markdown: string): string {
	const html = marked.parse(markdown, { async: false });
	return decodeHtmlEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|amp|gt|lt|quot|#39);/gi, (_match, entity: string) => {
		if (entity === "amp") {
			return "&";
		}
		if (entity === "gt") {
			return ">";
		}
		if (entity === "lt") {
			return "<";
		}
		if (entity === "quot") {
			return "\"";
		}
		if (entity === "#39") {
			return "'";
		}
		const codePoint = entity.startsWith("#x")
			? Number.parseInt(entity.slice(2), 16)
			: Number.parseInt(entity.slice(1), 10);
		return String.fromCodePoint(codePoint);
	});
}