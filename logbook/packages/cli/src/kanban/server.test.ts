import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { KANBAN_DISCOVERY_PATH, startKanbanServer, type KanbanServerHandle } from "./server.js";
import { runCli } from "../cli.js";

let handle: KanbanServerHandle | undefined;

afterEach(async () => {
	if (handle) {
		await new Promise<void>((resolve, reject) => {
			handle?.server.close((error) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
		handle = undefined;
	}
});

describe("Kanban server", () => {
	it("serves the application shell for root and component routes", async () => {
		handle = await startKanbanServer({ port: 0 });
		await new Promise<void>((resolve, reject) => {
			if (handle?.server.listening) {
				resolve();
				return;
			}

			handle?.server.once("listening", resolve);
			handle?.server.once("error", reject);
		});

		const rootResponse = await fetch(handle.info.url);
		const componentResponse = await fetch(`${handle.info.url}/components/kanban-button`);

		expect(rootResponse.status).toBe(200);
		expect(componentResponse.status).toBe(200);
		expect(await rootResponse.text()).toContain('<div id="app"></div>');
		expect(await componentResponse.text()).toContain('<div id="app"></div>');
	});

	it("serves available projects and boards through the Kanban discovery route", async () => {
		handle = await startKanbanServer({ port: 0 });

		const response = await fetch(`${handle.info.url}${KANBAN_DISCOVERY_PATH}`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			projects: expect.arrayContaining([
				expect.objectContaining({
					id: expect.any(String),
					name: expect.any(String),
					boards: expect.arrayContaining([expect.objectContaining({ id: expect.any(String), name: expect.any(String) })])
				})
			])
		});
	});

	it("stops a running Kanban server through the CLI", async () => {
		handle = await startKanbanServer({ port: 0 });
		const stdout = new PassThrough();
		let output = "";
		stdout.on("data", (chunk) => {
			output += chunk.toString();
		});

		const exitCode = await runCli(["kanban", "--stop", "--port", String(handle.info.port)], {
			stderr: new PassThrough(),
			stdout
		});

		expect(exitCode).toBe(0);
		expect(output).toContain(`Stopped Kanban at ${handle.info.url}`);
		handle = undefined;
	});
});