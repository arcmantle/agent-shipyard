const MAX_RESPONSE_BYTES = 64 * 1024;

export function formatMarkdownResponse(
	body: string,
	metadata: Record<string, unknown>,
	documentHash: string,
	toolName: string,
	offset = 0,
	expectedDocumentHash?: string,
	maxResponseBytes = MAX_RESPONSE_BYTES
) {
	const restart = `Discard all parts and restart ${toolName} without offset and documentHash.`;
	if (offset > 0 && expectedDocumentHash === undefined) {
		throw new Error(`Continuation requires documentHash. ${restart}`);
	}
	if (expectedDocumentHash !== undefined && expectedDocumentHash !== documentHash) {
		throw new Error(`Document changed or documentHash belongs to another source. ${restart}`);
	}
	const previousAtOffset = body.charCodeAt(offset - 1);
	const nextAtOffset = body.charCodeAt(offset);
	if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && offset >= body.length)
		|| (previousAtOffset >= 0xd800 && previousAtOffset <= 0xdbff && nextAtOffset >= 0xdc00 && nextAtOffset <= 0xdfff)) {
		throw new Error(`Invalid document offset. ${restart}`);
	}
	const responseAt = (position: number) => {
		let end = position;
		const previous = body.charCodeAt(end - 1);
		const next = body.charCodeAt(end);
		if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
		return { content: [
			{ type: "text" as const, text: JSON.stringify({ ...metadata, documentHash, offset, nextOffset: end < body.length ? end : null }) },
			{ type: "text" as const, text: body.slice(offset, end) }
		] };
	};
	let lower = offset;
	let upper = Math.min(body.length, offset + maxResponseBytes);
	while (lower < upper) {
		const middle = Math.ceil((lower + upper) / 2);
		if (Buffer.byteLength(JSON.stringify(responseAt(middle)), "utf8") <= maxResponseBytes) lower = middle;
		else upper = middle - 1;
	}
	const response = responseAt(lower);
	if (Buffer.byteLength(JSON.stringify(response), "utf8") > maxResponseBytes
		|| (offset < body.length && response.content[1].text.length === 0)) {
		throw new Error(`Document metadata exceeds the response budget. ${restart}`);
	}
	return response;
}