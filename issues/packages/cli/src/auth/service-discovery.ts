export type EntraServiceAuth = {
	provider: "entra";
	tenantId: string;
	clientId: string;
};

export type DiscoveredServiceAuth = {
	serviceUrl: string;
	auth: EntraServiceAuth;
};

export async function discoverServiceAuth(
	serviceUrl: string,
	fetch: typeof globalThis.fetch = globalThis.fetch
): Promise<DiscoveredServiceAuth> {
	const normalizedUrl = new URL(serviceUrl.trim());
	if (normalizedUrl.protocol !== "http:" && normalizedUrl.protocol !== "https:") {
		throw new Error(`Unsupported service URL protocol: ${normalizedUrl.protocol}`);
	}
	if (normalizedUrl.username || normalizedUrl.password) {
		throw new Error("Service URL must not contain embedded credentials.");
	}

	normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+$/, "");
	normalizedUrl.search = "";
	normalizedUrl.hash = "";
	const normalizedServiceUrl = normalizedUrl.toString().replace(/\/$/, "");
	const discoveryUrl = `${normalizedServiceUrl}/.well-known/agent-issues`;
	let response: Response;
	try {
		response = await fetch(discoveryUrl, { headers: { accept: "application/json" } });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not reach ${discoveryUrl}: ${message}`, { cause: error });
	}
	if (!response.ok) {
		throw new Error(`Service discovery failed with HTTP ${response.status} at ${discoveryUrl}.`);
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		throw new Error("Service returned malformed agent-issues auth metadata.", { cause: error });
	}
	const provider = readAuthProvider(body);
	if (provider !== undefined && provider !== "entra") {
		throw new Error(`Unsupported service authentication provider: "${provider}".`);
	}
	if (!isEntraMetadata(body)) {
		throw new Error("Service returned malformed agent-issues auth metadata.");
	}

	return { serviceUrl: normalizedServiceUrl, auth: body.auth };
}

function readAuthProvider(value: unknown): unknown {
	if (typeof value !== "object" || value === null || !("auth" in value)) return undefined;
	const auth = value.auth;
	if (typeof auth !== "object" || auth === null || !("provider" in auth)) return undefined;
	return auth.provider;
}

function isEntraMetadata(value: unknown): value is { auth: EntraServiceAuth } {
	if (typeof value !== "object" || value === null || !("auth" in value)) return false;
	const auth = value.auth;
	return (
		typeof auth === "object" &&
		auth !== null &&
		"provider" in auth &&
		auth.provider === "entra" &&
		"tenantId" in auth &&
		typeof auth.tenantId === "string" &&
		auth.tenantId.length > 0 &&
		"clientId" in auth &&
		typeof auth.clientId === "string" &&
		auth.clientId.length > 0
	);
}