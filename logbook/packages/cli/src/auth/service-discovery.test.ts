import { describe, expect, it, vi } from "vitest";

import { discoverServiceAuth } from "./service-discovery.js";

describe("discoverServiceAuth", () => {
	it("normalizes the service URL and returns discovered Entra configuration", async () => {
		const fetch = vi.fn(async () =>
			new Response(
				JSON.stringify({ auth: { provider: "entra", tenantId: "tenant-a", clientId: "client-a" } }),
				{ headers: { "content-type": "application/json" }, status: 200 }
			)
		);

		const result = await discoverServiceAuth("  HTTPS://API.Example.com///  ", fetch);

		expect(fetch).toHaveBeenCalledWith("https://api.example.com/.well-known/agent-issues", {
			headers: { accept: "application/json" }
		});
		expect(result).toEqual({
			serviceUrl: "https://api.example.com",
			auth: { provider: "entra", tenantId: "tenant-a", clientId: "client-a" }
		});
	});

	it("rejects malformed discovery metadata", async () => {
		const fetch = vi.fn(async () =>
			new Response(JSON.stringify({ auth: { provider: "entra", tenantId: "tenant-a" } }), { status: 200 })
		);

		await expect(discoverServiceAuth("https://api.example.com", fetch)).rejects.toThrow(
			"Service returned malformed agent-issues auth metadata."
		);
	});

	it("rejects unsupported authentication providers explicitly", async () => {
		const fetch = vi.fn(async () =>
			new Response(JSON.stringify({ auth: { provider: "github", clientId: "client-a" } }), { status: 200 })
		);

		await expect(discoverServiceAuth("https://api.example.com", fetch)).rejects.toThrow(
			'Unsupported service authentication provider: "github".'
		);
	});

	it("reports an unreachable discovery endpoint with its normalized URL", async () => {
		const fetch = vi.fn(async () => {
			throw new Error("connection refused");
		});

		await expect(discoverServiceAuth("HTTPS://API.Example.com/", fetch)).rejects.toThrow(
			"Could not reach https://api.example.com/.well-known/agent-issues: connection refused"
		);
	});

	it("reports non-success HTTP responses without accepting their body as metadata", async () => {
		const fetch = vi.fn(async () =>
			new Response(JSON.stringify({ auth: { provider: "entra", tenantId: "tenant-a", clientId: "client-a" } }), {
				status: 503
			})
		);

		await expect(discoverServiceAuth("https://api.example.com", fetch)).rejects.toThrow(
			"Service discovery failed with HTTP 503 at https://api.example.com/.well-known/agent-issues."
		);
	});

	it("reports invalid JSON as malformed metadata", async () => {
		const fetch = vi.fn(async () => new Response("not-json", { status: 200 }));

		await expect(discoverServiceAuth("https://api.example.com", fetch)).rejects.toThrow(
			"Service returned malformed agent-issues auth metadata."
		);
	});

	it("removes query and fragment components before discovery", async () => {
		const fetch = vi.fn(async () =>
			new Response(JSON.stringify({ auth: { provider: "entra", tenantId: "tenant-a", clientId: "client-a" } }))
		);

		await discoverServiceAuth("https://api.example.com/base/?source=cli#login", fetch);

		expect(fetch).toHaveBeenCalledWith("https://api.example.com/base/.well-known/agent-issues", {
			headers: { accept: "application/json" }
		});
	});

	it("rejects service URLs containing embedded credentials", async () => {
		await expect(discoverServiceAuth("https://user:secret@api.example.com")).rejects.toThrow(
			"Service URL must not contain embedded credentials."
		);
	});
});