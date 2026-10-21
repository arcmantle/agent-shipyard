import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { subscribeToCloudEvents } from "./cloud-events-relay.js";

function startFakeSseGate(input: { onRequest?: (authorization: string | undefined) => void } = {}): {
	push: (event: unknown) => void;
	server: Server;
	url: string;
} {
	let sendResponse: ((chunk: string) => void) | undefined;

	const server = createServer((request, response) => {
		input.onRequest?.(request.headers.authorization);
		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive"
		});
		response.write(`data: ${JSON.stringify({ type: "connected", at: new Date().toISOString() })}\n\n`);
		sendResponse = (chunk) => response.write(chunk);
		request.on("close", () => {
			sendResponse = undefined;
		});
	});

	server.listen(0);
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	return {
		push: (event: unknown) => {
			sendResponse?.(`data: ${JSON.stringify(event)}\n\n`);
		},
		server,
		url: `http://127.0.0.1:${port}`
	};
}

describe("subscribeToCloudEvents", () => {
	const stops: Array<() => void> = [];
	const servers: Server[] = [];

	afterEach(() => {
		for (const stop of stops.splice(0)) stop();
		for (const server of servers.splice(0)) server.close();
	});

	it("relays snapshot-changed events from the cloud gate's SSE stream", async () => {
		const gate = startFakeSseGate();
		servers.push(gate.server);

		const received: unknown[] = [];
		const stop = subscribeToCloudEvents(
			{ baseUrl: gate.url, bearerToken: "token-a" },
			(event) => received.push(event)
		);
		stops.push(stop);

		await new Promise((resolve) => setTimeout(resolve, 50));
		gate.push({
			affectedEntityIds: ["ISS1"],
			affectedInitiativeIds: ["INIT1"],
			at: "2024-01-01T00:00:00.000Z",
			category: "entity",
			correlationId: "write-1",
			projectId: "PROJ1",
			type: "snapshot-changed"
		});
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(received).toEqual([{
			affectedEntityIds: ["ISS1"],
			affectedInitiativeIds: ["INIT1"],
			at: "2024-01-01T00:00:00.000Z",
			category: "entity",
			correlationId: "write-1",
			projectId: "PROJ1",
			type: "snapshot-changed"
		}]);
	});

	it("does not relay the gate's own connected event", async () => {
		const gate = startFakeSseGate();
		servers.push(gate.server);

		const received: unknown[] = [];
		const stop = subscribeToCloudEvents(
			{ baseUrl: gate.url, bearerToken: "token-a" },
			(event) => received.push(event)
		);
		stops.push(stop);

		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(received).toEqual([]);
	});

	it("attaches the bearer token to the request", async () => {
		let receivedAuthorization: string | undefined;
		const gate = startFakeSseGate({ onRequest: (authorization) => (receivedAuthorization = authorization) });
		servers.push(gate.server);

		const stop = subscribeToCloudEvents({ baseUrl: gate.url, bearerToken: "token-a" }, () => {});
		stops.push(stop);

		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(receivedAuthorization).toBe("Bearer token-a");
	});

	it("stops relaying once unsubscribed", async () => {
		const gate = startFakeSseGate();
		servers.push(gate.server);

		const received: unknown[] = [];
		const stop = subscribeToCloudEvents(
			{ baseUrl: gate.url, bearerToken: "token-a" },
			(event) => received.push(event)
		);

		await new Promise((resolve) => setTimeout(resolve, 50));
		stop();
		await new Promise((resolve) => setTimeout(resolve, 50));
		gate.push({ type: "snapshot-changed", at: "2024-01-01T00:00:00.000Z" });
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(received).toEqual([]);
	});
});
