/**
 * Wire shapes for the cloud API's JSON-RPC surface (ADR14): plain JSON over
 * HTTP, one method per `StorageDriver` operation. Error codes follow the
 * JSON-RPC 2.0 spec's reserved ranges where they apply; `-32000` is this
 * gate's single implementation-defined "the underlying store method threw"
 * bucket, since callers only ever need the thrown `Error.message`, not a
 * enumerated catalogue of business-rule failures.
 */
export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
};

export type JsonRpcSuccessResponse = {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: unknown;
};

export type JsonRpcErrorResponse = {
	jsonrpc: "2.0";
	id: JsonRpcId;
	error: {
		code: number;
		message: string;
		data?: unknown;
	};
};

export const JSON_RPC_ERROR_CODES = {
	methodNotFound: -32601,
	serverError: -32000
} as const;

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const candidate = value as Record<string, unknown>;
	return candidate.jsonrpc === "2.0" && typeof candidate.method === "string";
}
