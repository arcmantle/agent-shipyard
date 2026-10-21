import { createServer, request as sendRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

import { getBuiltKanbanAssetPath, getKanbanContentType } from "./assets.js";

export type KanbanServerInfo = {
	host: string;
	port: number;
	url: string;
};

export type KanbanServerHandle = {
	info: KanbanServerInfo;
	server: Server;
	close: () => void;
};

export type StopKanbanServerResult = {
	host: string;
	port: number;
	reachable: boolean;
	stopped: boolean;
	url: string;
};

export const KANBAN_HEALTH_PATH = "/__agent_issues/kanban/health";
export const KANBAN_STOP_PATH = "/__agent_issues/kanban/stop";
export const KANBAN_DISCOVERY_PATH = "/__agent_issues/kanban/discovery";

const KANBAN_DISCOVERY = {
	projects: [
		{
			id: "agent-issues",
			name: "Agent Issues",
			boards: [
				{ id: "active-work", name: "Active work" }
			]
		}
	]
};

export async function startKanbanServer(input: { host?: string; port?: number } = {}): Promise<KanbanServerHandle> {
	const host = input.host ?? "127.0.0.1";
	const port = input.port ?? 4174;
	const server = createServer((request, response) => {
		handleRequest({ request, response, server });
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Could not determine the Kanban server address.");
	}
	const info: KanbanServerInfo = {
		host,
		port: address.port,
		url: `http://${host}:${address.port}`
	};

	return {
		info,
		server,
		close: () => {
			server.close();
		}
	};
}

export async function stopKanbanServer(input: { host?: string; port?: number } = {}): Promise<StopKanbanServerResult> {
	const host = input.host ?? "127.0.0.1";
	const port = input.port ?? 4174;
	const url = `http://${host}:${port}`;

	return await new Promise<StopKanbanServerResult>((resolve, reject) => {
		let timedOut = false;
		const request = sendRequest(
			{
				host,
				method: "POST",
				path: KANBAN_STOP_PATH,
				port
			},
			(response) => {
				response.resume();
				response.once("end", () => {
					resolve({
						host,
						port,
						reachable: true,
						stopped: response.statusCode === 200,
						url
					});
				});
			}
		);

		request.setTimeout(500, () => {
			timedOut = true;
			request.destroy(new Error("Timed out waiting for the Kanban server stop response."));
		});

		request.once("error", (error) => {
			const code = (error as NodeJS.ErrnoException).code;
			if (timedOut) {
				resolve({ host, port, reachable: true, stopped: false, url });
				return;
			}

			if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") {
				resolve({ host, port, reachable: false, stopped: false, url });
				return;
			}

			reject(error);
		});

		request.end();
	});
}

function handleRequest(input: { request: IncomingMessage; response: ServerResponse; server: Server }) {
	const requestUrl = new URL(input.request.url ?? "/", "http://127.0.0.1");
	if (requestUrl.pathname === KANBAN_HEALTH_PATH) {
		if (input.request.method !== "GET") {
			writeText(input.response, 405, "Method Not Allowed");
			return;
		}

		writeText(input.response, 200, "Kanban server running");
		return;
	}

	if (requestUrl.pathname === KANBAN_STOP_PATH) {
		if (input.request.method !== "POST") {
			writeText(input.response, 405, "Method Not Allowed");
			return;
		}

		writeText(input.response, 200, "Stopping Kanban server");
		setImmediate(() => {
			input.server.close();
		});
		return;
	}

	if (requestUrl.pathname === KANBAN_DISCOVERY_PATH) {
		if (input.request.method !== "GET") {
			writeText(input.response, 405, "Method Not Allowed");
			return;
		}

		writeJson(input.response, 200, KANBAN_DISCOVERY);
		return;
	}

	if (input.request.method !== "GET") {
		writeText(input.response, 405, "Method Not Allowed");
		return;
	}

	const assetPath = getBuiltKanbanAssetPath(requestUrl.pathname);
	const fallbackPath = getBuiltKanbanAssetPath("/");
	const filePath = assetPath ?? fallbackPath;

	if (!filePath) {
		writeText(input.response, 404, "Not Found");
		return;
	}

	input.response.writeHead(200, {
		"Cache-Control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
		"Content-Type": getKanbanContentType(filePath)
	});
	input.response.end(readFileSync(filePath));
}

function writeText(response: ServerResponse, statusCode: number, body: string) {
	response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
	response.end(body);
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown) {
	response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
}