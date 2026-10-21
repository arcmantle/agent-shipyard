import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { shortEntityReference } from "@agent-issues/core";
import { isEntrypointInvocation, runCli, shouldRunLocalDaemon, shouldRunMcpServer } from "../cli.js";
import { main } from "./index.js";
import { createEntity, ensureDatabase, getDatabaseSnapshot, getEntityDetails, getProjectDiscovery, listEntities, listTenants, materializeEntityRevision, openSqliteStore } from "@agent-issues/api-local";
import { LOCAL_DAEMON_SPAWN_FLAG } from "../daemon/local-daemon-store.js";
import { MCP_SERVER_FLAG, parseMcpProjectIdentity, PROJECT_IDENTITY_FLAG } from "../mcp-server/runner.js";
import { startLiveSite } from "../site/index.js";
import packageJson from "../../package.json" with { type: "json" };

let tempDir: string | null = null;
const liveSiteClosers = new Set<() => void>();

function createTempDir(): string {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-cli-"));
	const workspace = path.join(tempDir, "default-project");
	mkdirSync(workspace);
	return workspace;
}

function writeBodyFile(root: string, content: string): string {
	const bodyFilePath = path.join(root, `body-${Math.random().toString(36).slice(2)}.md`);
	writeFileSync(bodyFilePath, content);
	return bodyFilePath;
}

function createCapture() {
	const stream = new PassThrough();
	let text = "";

	stream.on("data", (chunk) => {
		text += chunk.toString();
	});

	return {
		stream,
		read: () => text
	};
}

// Opens a real SSE connection and resolves once a `snapshot-changed` event
// arrives (mirrors `cloud-site-server.test.ts`'s helper of the same name).
function waitForSnapshotChangedEvent(url: string): { event: Promise<unknown>; ready: Promise<void>; stop: () => void } {
	let resolveEvent!: (value: unknown) => void;
	const promise = new Promise<unknown>((resolve) => {
		resolveEvent = resolve;
	});
	let resolveReady!: () => void;
	let rejectReady!: (reason?: unknown) => void;
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});

	const controller = new AbortController();
	void (async () => {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.body) {
			rejectReady(new Error("SSE response has no body."));
			return;
		}
		resolveReady();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				buffer += decoder.decode(chunk, { stream: true });
				let boundary = buffer.indexOf("\n\n");
				while (boundary !== -1) {
					const rawEvent = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data:"));
					if (dataLine) {
						const parsed = JSON.parse(dataLine.slice("data:".length).trim());
						if (parsed.type === "snapshot-changed") {
							resolveEvent(parsed);
						}
					}
					boundary = buffer.indexOf("\n\n");
				}
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				rejectReady(error);
			}
			// aborted
		}
	})();

	return { event: promise, ready, stop: () => controller.abort() };
}

afterEach(() => {
	for (const close of liveSiteClosers) {
		close();
	}
	liveSiteClosers.clear();

	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

async function getAvailablePort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => reject(new Error("Could not determine an available port.")));
				return;
			}

			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}

				resolve(address.port);
			});
		});
	});
}

describe("cli", () => {
	it("reports the resolved project identity", async () => {
		const root = createTempDir();
		const stdout = createCapture();

		expect(await runCli(["project-identity", "--json"], {
			cwd: root,
			stderr: createCapture().stream,
			stdout: stdout.stream
		})).toBe(0);

		expect(JSON.parse(stdout.read())).toEqual({
			command: "project-identity",
			identity: "default-project",
			source: "folder-name"
		});
	});

	it("reports the resolved project identity in text output", async () => {
		const root = createTempDir();
		const stdout = createCapture();

		expect(await runCli(["project-identity"], {
			cwd: root,
			stderr: createCapture().stream,
			stdout: stdout.stream
		})).toBe(0);

		expect(stdout.read()).toBe("Project identity: default-project\nSource: folder-name\n");
	});

	it("uses --project-identity to select another project's data", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "project-override.db");
		const previousNoDaemon = process.env.AGENT_ISSUES_NO_DAEMON;
		process.env.AGENT_ISSUES_NO_DAEMON = "1";

		try {
			const createOutput = createCapture();
			expect(await runCli(["create", "initiative", "--title", "Remote project", "--project-identity", "PROJ_REMOTE", "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: createOutput.stream
			})).toBe(0);

			const listOutput = createCapture();
			expect(await runCli(["list", "initiative", "--project-identity", "PROJ_REMOTE", "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: listOutput.stream
			})).toBe(0);

			expect(JSON.parse(listOutput.read())).toMatchObject({ items: [{ title: "Remote project" }] });
		} finally {
			if (previousNoDaemon === undefined) {
				delete process.env.AGENT_ISSUES_NO_DAEMON;
			} else {
				process.env.AGENT_ISSUES_NO_DAEMON = previousNoDaemon;
			}
		}
	});

	it("stops live sites through site --stop", async () => {
		const root = createTempDir();
		const previousNoDaemon = process.env.AGENT_ISSUES_NO_DAEMON;
		process.env.AGENT_ISSUES_NO_DAEMON = "1";

		try {
			for (const command of ["site"]) {
				const port = await getAvailablePort();
				const handle = await startLiveSite({ currentWorkingDirectory: root, port });
				await new Promise<void>((resolve) => handle.server.once("listening", resolve));
				const closed = new Promise<void>((resolve) => handle.server.once("close", resolve));
				const output = createCapture();

				expect(await runCli([command, "--stop", "--port", String(port), "--json"], {
					cwd: root,
					stderr: createCapture().stream,
					stdout: output.stream
				})).toBe(0);
				await closed;
				expect(JSON.parse(output.read())).toMatchObject({ port, stopped: true });
			}
		} finally {
			if (previousNoDaemon === undefined) {
				delete process.env.AGENT_ISSUES_NO_DAEMON;
			} else {
				process.env.AGENT_ISSUES_NO_DAEMON = previousNoDaemon;
			}
		}
	});

	it.each(["bind", "unbind", "status"])("rejects the removed cloud %s command", async (subcommand) => {
		await expect(runCli(["cloud", subcommand])).rejects.toThrow(/Extraneous positional argument/);
	});

	it.each(["--local", "--cloud"])("rejects the removed %s backend option", async (option) => {
		await expect(runCli(["status", option])).rejects.toThrow(/Unsupported option name/);
	});

	it("parses an MCP project identity override", () => {
		expect(parseMcpProjectIdentity([PROJECT_IDENTITY_FLAG, "PROJ_REMOTE"])).toBe("PROJ_REMOTE");
		expect(parseMcpProjectIdentity([])).toBeUndefined();
		expect(() => parseMcpProjectIdentity([PROJECT_IDENTITY_FLAG])).toThrow(/Usage/);
	});

	it("prints help when invoked without a command", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli([], { stderr: stderr.stream, stdout: stdout.stream });

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain("agent-issues help");
	});

	it.each([
		{
			args: ["agent", "init"],
			host: "copilot",
			expected: [
				["copilot", "plugin", "marketplace", "list", "--json"],
				["copilot", "plugin", "marketplace", "add", "arcmantle/agent-issues-plugin"],
				["copilot", "plugin", "install", "agent-issues@agent-issues"]
			]
		},
		{
			args: ["agent", "init", "--host", "claude"],
			host: "claude",
			expected: [
				["claude", "plugin", "marketplace", "list", "--json"],
				["claude", "plugin", "marketplace", "add", "arcmantle/agent-issues-plugin"],
				["claude", "plugin", "install", "agent-issues@agent-issues", "--scope", "user"]
			]
		}
	])("initializes the plugin through $host", async ({ args, host, expected }) => {
		const stdout = createCapture();
		const stderr = createCapture();
		Object.assign(stderr.stream, { isTTY: true });
		const commands: string[][] = [];

		expect(await runCli([...args, "--json"], {
			cwd: createTempDir(),
			stderr: stderr.stream,
			stdout: stdout.stream,
			agentInitDependencies: {
				run: async (command, commandArgs) => {
					commands.push([command, ...commandArgs]);
					return "[]";
				}
			}
		})).toBe(0);

		expect(commands).toEqual(expected);
		expect(JSON.parse(stdout.read())).toEqual({
			command: "agent-init",
			host,
			marketplace: "arcmantle/agent-issues-plugin",
			plugin: "agent-issues@agent-issues"
		});
		expect(stderr.read()).toBe("");
	});

	it("does not show a spinner for non-interactive text output", async () => {
		const stderr = createCapture();
		const commands: Array<{ args: string[]; quiet: boolean }> = [];

		expect(await runCli(["agent", "init"], {
			cwd: createTempDir(),
			stderr: stderr.stream,
			agentInitDependencies: {
				run: async (_command, args, options) => {
					commands.push({ args, quiet: options.quiet });
					return "[]";
				}
			}
		})).toBe(0);

		expect(stderr.read()).toBe("");
		expect(commands).toEqual([
			{ args: ["plugin", "marketplace", "list", "--json"], quiet: true },
			{ args: ["plugin", "marketplace", "add", "arcmantle/agent-issues-plugin"], quiet: false },
			{ args: ["plugin", "install", "agent-issues@agent-issues"], quiet: false }
		]);
	});

	it("skips marketplace registration when the marketplace already exists", async () => {
		const commands: string[][] = [];

		expect(await runCli(["agent", "init"], {
			cwd: createTempDir(),
			agentInitDependencies: {
				run: async (command, commandArgs) => {
					commands.push([command, ...commandArgs]);
					return JSON.stringify([{ name: "agent-issues" }]);
				}
			}
		})).toBe(0);

		expect(commands).toEqual([
			["copilot", "plugin", "marketplace", "list", "--json"],
			["copilot", "plugin", "install", "agent-issues@agent-issues"]
		]);
	});

	it("shows an installation spinner in an interactive terminal", async () => {
		const stdout = createCapture();
		const stderr = createCapture();
		Object.assign(stderr.stream, {
			clearLine: () => true,
			cursorTo: () => true,
			isTTY: true,
			moveCursor: () => true
		});
		const commands: Array<{ args: string[]; quiet: boolean }> = [];

		expect(await runCli(["agent", "init"], {
			cwd: createTempDir(),
			stderr: stderr.stream,
			stdout: stdout.stream,
			agentInitDependencies: {
				run: async (_command, args, options) => {
					if (args[2] === "list") {
						expect(stderr.read()).toContain("Installing the Agent Issues plugin for copilot...");
					}

					commands.push({ args, quiet: options.quiet });
					return "[]";
				}
			}
		})).toBe(0);

		expect(stderr.read()).toContain("Installing the Agent Issues plugin for copilot...");
		expect(commands).toEqual([
			{ args: ["plugin", "marketplace", "list", "--json"], quiet: true },
			{ args: ["plugin", "marketplace", "add", "arcmantle/agent-issues-plugin"], quiet: true },
			{ args: ["plugin", "install", "agent-issues@agent-issues"], quiet: true }
		]);
	});

	it("uses bootstrap progress without rendering a second spinner", async () => {
		const stdout = createCapture();
		const stderr = createCapture();
		Object.assign(stderr.stream, {
			clearLine: () => true,
			cursorTo: () => true,
			isTTY: true,
			moveCursor: () => true
		});
		const commands: Array<{ args: string[]; quiet: boolean }> = [];

		expect(await runCli(["agent", "init"], {
			agentInitProgressActive: true,
			cwd: createTempDir(),
			stderr: stderr.stream,
			stdout: stdout.stream,
			agentInitDependencies: {
				run: async (_command, args, options) => {
					commands.push({ args, quiet: options.quiet });
					return "[]";
				}
			}
		})).toBe(0);

		expect(stderr.read()).toBe("");
		expect(commands).toEqual([
			{ args: ["plugin", "marketplace", "list", "--json"], quiet: true },
			{ args: ["plugin", "marketplace", "add", "arcmantle/agent-issues-plugin"], quiet: true },
			{ args: ["plugin", "install", "agent-issues@agent-issues"], quiet: true }
		]);
	});

	it("rejects an unsupported agent host", async () => {
		await expect(runCli(["agent", "init", "--host", "cursor"])).rejects.toThrow(
			"Unsupported plugin host: cursor. Use copilot or claude."
		);
	});

	it("propagates a host command failure", async () => {
		await expect(runCli(["agent", "init"], {
			cwd: createTempDir(),
			agentInitDependencies: {
				run: async () => {
					throw new Error("Could not run copilot: command not found");
				}
			}
		})).rejects.toThrow("Could not run copilot: command not found");
	});

	it("stops the spinner when an interactive installation command fails", async () => {
		const stderr = createCapture();
		let clearedLines = 0;
		Object.assign(stderr.stream, {
			clearLine: () => {
				clearedLines += 1;
				return true;
			},
			cursorTo: () => true,
			isTTY: true,
			moveCursor: () => true
		});
		let callCount = 0;

		await expect(runCli(["agent", "init"], {
			cwd: createTempDir(),
			stderr: stderr.stream,
			agentInitDependencies: {
				run: async () => {
					callCount += 1;
					if (callCount === 1) {
						return "[]";
					}

					throw new Error("Could not run copilot: command not found");
				}
			}
		})).rejects.toThrow("Could not run copilot: command not found");

		expect(stderr.read()).toContain("Installing the Agent Issues plugin for copilot...");
		expect(clearedLines).toBeGreaterThan(0);
	});

	it("creates an initiative-owned Plan and marks it ready", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "plan.db");
		const previousNoDaemon = process.env.AGENT_ISSUES_NO_DAEMON;
		process.env.AGENT_ISSUES_NO_DAEMON = "1";

		try {
			const initiativeOutput = createCapture();
			expect(await runCli(["create", "initiative", "--title", "Plan owner", "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: initiativeOutput.stream
			})).toBe(0);
			const initiative = JSON.parse(initiativeOutput.read());
			const planOutput = createCapture();
			const bodyFile = writeBodyFile(root, "## Goal\n\nBuild the feature.\n\n## Context\n\nTrack its decisions.");
			expect(await runCli(["create", "plan", "--title", "Feature plan", "--parent", initiative.reference, "--body-file", bodyFile, "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: planOutput.stream
			})).toBe(0);
			const plan = JSON.parse(planOutput.read());

			expect(plan).toMatchObject({ operation: "create", status: "draft" });
			expect(plan.reference).toMatch(/^PLAN_[0-9A-HJKMNP-TV-Z]{26}$/);
			const planDetailsOutput = createCapture();
			expect(await runCli(["show", plan.reference, "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: planDetailsOutput.stream
			})).toBe(0);
			expect(JSON.parse(planDetailsOutput.read())).toMatchObject({ entity: { body: "## Goal\n\nBuild the feature.\n\n## Context\n\nTrack its decisions.", kind: "plan", status: "draft" } });

			const statusOutput = createCapture();
			expect(await runCli(["status", plan.reference, "ready", "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: statusOutput.stream
			})).toBe(0);
			expect(JSON.parse(statusOutput.read())).toMatchObject({ operation: "status", reference: plan.reference, status: "ready", previousStatus: "draft" });
		} finally {
			if (previousNoDaemon === undefined) {
				delete process.env.AGENT_ISSUES_NO_DAEMON;
			} else {
				process.env.AGENT_ISSUES_NO_DAEMON = previousNoDaemon;
			}
		}
	}, 15_000);

	it("creates and reads an issue-breakdown draft", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "issue-breakdown.db");
		const previousNoDaemon = process.env.AGENT_ISSUES_NO_DAEMON;
		process.env.AGENT_ISSUES_NO_DAEMON = "1";

		try {
			const initiativeOutput = createCapture();
			expect(await runCli(["create", "initiative", "--title", "Draft target", "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: initiativeOutput.stream
			})).toBe(0);
			const initiative = JSON.parse(initiativeOutput.read()) as { reference: string };
			const inputPath = path.join(root, "issue-breakdown.json");
			writeFileSync(inputPath, JSON.stringify({
				issues: [{
					key: "draft-storage",
					title: "Add draft storage",
					outcome: "Store the proposed graph.",
					scope: ["Add the draft store."],
					workMode: "AFK",
					acceptanceCriteria: ["A draft is retrievable."],
					relationReferences: []
				}]
			}));
			const createdOutput = createCapture();
			expect(await runCli(["issue-breakdown", "create", initiative.reference, "--input-file", inputPath, "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: createdOutput.stream
			})).toBe(0);
			const draft = JSON.parse(createdOutput.read()) as { id: string; snapshotDigest: string; targetReference: string };
			expect(draft).toMatchObject({ targetReference: initiative.reference, snapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });

			const readOutput = createCapture();
			expect(await runCli(["issue-breakdown", "show", draft.id, "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: readOutput.stream
			})).toBe(0);
			expect(JSON.parse(readOutput.read())).toMatchObject({
				id: draft.id,
				issues: [expect.objectContaining({ key: "draft-storage", title: "Add draft storage" })]
			});

			const latestOutput = createCapture();
			expect(await runCli(["issue-breakdown", "latest", initiative.reference, "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: latestOutput.stream
			})).toBe(0);
			expect(JSON.parse(latestOutput.read())).toMatchObject({ id: draft.id });

			const approvalOutput = createCapture();
			expect(await runCli(["issue-breakdown", "approve", draft.id, "--snapshot-digest", draft.snapshotDigest, "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: approvalOutput.stream
			})).toBe(0);
			expect(JSON.parse(approvalOutput.read())).toMatchObject({
				status: "approved",
				targetReference: initiative.reference,
				createdIssueReferences: [expect.any(String)]
			});

			await expect(runCli(["issue-breakdown", "approve", draft.id, "--snapshot-digest", "invalid", "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: createCapture().stream
			})).rejects.toThrow("--snapshot-digest must be a 64-character lowercase SHA-256 digest.");
		} finally {
			if (previousNoDaemon === undefined) {
				delete process.env.AGENT_ISSUES_NO_DAEMON;
			} else {
				process.env.AGENT_ISSUES_NO_DAEMON = previousNoDaemon;
			}
		}
	});

	it("adds and lists an issue comment with explicit references", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "comments.db");
		const output = createCapture();
		const previousNoDaemon = process.env.AGENT_ISSUES_NO_DAEMON;
		process.env.AGENT_ISSUES_NO_DAEMON = "1";

		try {
			const issueOutput = createCapture();
			expect(await runCli(["create", "issue", "--title", "Conversation host", "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: issueOutput.stream
			})).toBe(0);
			const issue = JSON.parse(issueOutput.read());
			const referencedIssueOutput = createCapture();
			expect(await runCli(["create", "issue", "--title", "Referenced issue", "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: referencedIssueOutput.stream
			})).toBe(0);
			const referencedIssue = JSON.parse(referencedIssueOutput.read());
			const bodyFile = writeBodyFile(root, "A comment from the CLI.");

			expect(await runCli([
				"comment",
				"add",
				issue.reference,
				"--body-file",
				bodyFile,
				"--reference",
				referencedIssue.reference,
				"--db",
				dbPath,
				"--json"
			], { cwd: root, stderr: createCapture().stream, stdout: output.stream })).toBe(0);

			const added = JSON.parse(output.read());
			expect(added).toMatchObject({
				issueId: issue.id,
				referencedIssueIds: [referencedIssue.id],
				tombstone: false
			});
			expect(added).not.toHaveProperty("body");

			const listed = createCapture();
			expect(await runCli(["comment", "list", issue.reference, "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: listed.stream
			})).toBe(0);
			expect(JSON.parse(listed.read())).toMatchObject({
				comments: [expect.objectContaining({ body: "A comment from the CLI.", referencedIssueIds: [referencedIssue.id] })],
				total: 1,
				nextBefore: null
			});
		} finally {
			if (previousNoDaemon === undefined) {
				delete process.env.AGENT_ISSUES_NO_DAEMON;
			} else {
				process.env.AGENT_ISSUES_NO_DAEMON = previousNoDaemon;
			}
		}
	});

	it("edits an issue comment with replacement explicit references", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "comments-edit.db");
		const previousNoDaemon = process.env.AGENT_ISSUES_NO_DAEMON;
		process.env.AGENT_ISSUES_NO_DAEMON = "1";

		try {
			const createIssue = async (title: string) => {
				const output = createCapture();
				expect(await runCli(["create", "issue", "--title", title, "--db", dbPath, "--json"], {
					cwd: root,
					stderr: createCapture().stream,
					stdout: output.stream
				})).toBe(0);
				return JSON.parse(output.read());
			};
			const issue = await createIssue("Conversation host");
			const initialReference = await createIssue("Initial reference");
			const replacementReference = await createIssue("Replacement reference");
			const addOutput = createCapture();
			expect(await runCli([
				"comment",
				"add",
				issue.reference,
				"--body-file",
				writeBodyFile(root, "Initial comment."),
				"--reference",
				initialReference.reference,
				"--db",
				dbPath,
				"--json"
			], { cwd: root, stderr: createCapture().stream, stdout: addOutput.stream })).toBe(0);
			const added = JSON.parse(addOutput.read());

			const editOutput = createCapture();
			expect(await runCli([
				"comment",
				"edit",
				issue.reference,
				added.reference,
				"--body-file",
				writeBodyFile(root, "Edited comment."),
				"--reference",
				replacementReference.reference,
				"--db",
				dbPath,
				"--json"
			], { cwd: root, stderr: createCapture().stream, stdout: editOutput.stream })).toBe(0);

			expect(JSON.parse(editOutput.read())).toMatchObject({
				body: "Edited comment.",
				referencedIssueIds: [replacementReference.id],
				revision: 2
			});
		} finally {
			if (previousNoDaemon === undefined) {
				delete process.env.AGENT_ISSUES_NO_DAEMON;
			} else {
				process.env.AGENT_ISSUES_NO_DAEMON = previousNoDaemon;
			}
		}
	});

	it("deletes an issue comment and retains its history", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "comments-delete.db");
		const previousNoDaemon = process.env.AGENT_ISSUES_NO_DAEMON;
		process.env.AGENT_ISSUES_NO_DAEMON = "1";

		try {
			const issueOutput = createCapture();
			expect(await runCli(["create", "issue", "--title", "Conversation host", "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: issueOutput.stream
			})).toBe(0);
			const issue = JSON.parse(issueOutput.read());
			const addOutput = createCapture();
			expect(await runCli([
				"comment",
				"add",
				issue.reference,
				"--body-file",
				writeBodyFile(root, "A comment that will be deleted."),
				"--db",
				dbPath,
				"--json"
			], { cwd: root, stderr: createCapture().stream, stdout: addOutput.stream })).toBe(0);
			const added = JSON.parse(addOutput.read());

			const deleteOutput = createCapture();
			expect(await runCli(["comment", "delete", issue.reference, added.reference, "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: deleteOutput.stream
			})).toBe(0);
			expect(JSON.parse(deleteOutput.read())).toMatchObject({
				reference: added.reference,
				tombstone: true,
				revision: 2
			});

			const historyOutput = createCapture();
			expect(await runCli(["comment", "history", added.reference, "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: historyOutput.stream
			})).toBe(0);
			expect(JSON.parse(historyOutput.read())).toEqual([
				expect.objectContaining({ body: "A comment that will be deleted.", tombstone: false, targetRevision: 1 }),
				expect.objectContaining({ body: "A comment that will be deleted.", tombstone: true, targetRevision: 2 })
			]);
		} finally {
			if (previousNoDaemon === undefined) {
				delete process.env.AGENT_ISSUES_NO_DAEMON;
			} else {
				process.env.AGENT_ISSUES_NO_DAEMON = previousNoDaemon;
			}
		}
	});

	it("routes command help through the existing help renderer", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["create", "--help"], { stderr: stderr.stream, stdout: stdout.stream });

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain("agent-issues create <kind>");
	});

	it("documents issue comments as issue-owned database records", async () => {
		const commentStdout = createCapture();
		const commentExitCode = await runCli(["comment", "--json"], { stderr: createCapture().stream, stdout: commentStdout.stream });

		expect(commentExitCode).toBe(0);
		const commentHelp = JSON.parse(commentStdout.read()).command;
		expect(commentHelp.name).toBe("comment");
		expect(commentHelp.usage).toContain("agent-issues comment add <issueId> --body-file <path|-> [--reference <issueId>]");
		expect(commentHelp.notes).toContain("Issue comments are database records owned by an issue. They are not workflow entity kinds.");

		const schemaStdout = createCapture();
		const schemaExitCode = await runCli(["schema", "--json"], { stderr: createCapture().stream, stdout: schemaStdout.stream });

		expect(schemaExitCode).toBe(0);
		expect(JSON.parse(schemaStdout.read()).issueComments).toEqual(expect.objectContaining({
			storage: "database",
			parentKind: "issue",
			recordPrefix: "COM",
			listCommand: "agent-issues comment list <issueId> [--before <cursor>] [--all] --json"
		}));
	});

	it("documents Plan creation and Plan-entry operations", async () => {
		const createStdout = createCapture();
		const createExitCode = await runCli(["help", "create", "--json"], {
			stderr: createCapture().stream,
			stdout: createStdout.stream
		});
		const createHelp = JSON.parse(createStdout.read()).command;

		expect(createExitCode).toBe(0);
		expect(createHelp.examples).toContain('agent-issues create plan --title "Routing decision" --parent INIT1 --body-file -');
		expect(createHelp.notes).toContain("A Plan requires an initiative parent. Use `plan-entry` to record its questions and decisions.");

		const planEntryStdout = createCapture();
		const planEntryExitCode = await runCli(["help", "plan-entry", "--json"], {
			stderr: createCapture().stream,
			stdout: planEntryStdout.stream
		});
		const planEntryHelp = JSON.parse(planEntryStdout.read()).command;

		expect(planEntryExitCode).toBe(0);
		expect(planEntryHelp.usage).toContain("agent-issues plan-entry add <planId> --role <question|decision|scope|constraint|preference|consideration> --body-file <path|-> [--scope-direction <included|excluded>] [--reference <entityId>] [--supersedes <entryId>]");
		expect(planEntryHelp.examples).toContain("agent-issues link PLAN_ENTRY1 informs ISS1");
		expect(planEntryHelp.notes).toContain("Link an existing Plan entry to an entity with `agent-issues link <planEntryId> informs <targetId>`." );
		expect(planEntryHelp.notes).toContain("A decision can supersede question or decision entries.");

		const linkStdout = createCapture();
		const linkExitCode = await runCli(["help", "link", "--json"], {
			stderr: createCapture().stream,
			stdout: linkStdout.stream
		});
		const linkHelp = JSON.parse(linkStdout.read()).command;

		expect(linkExitCode).toBe(0);
		expect(linkHelp.examples).toContain("agent-issues link PLAN_ENTRY1 informs ISS1");
		expect(linkHelp.notes).toContain("A Plan entry can link only to an entity in the current project and only as `informs`.");

		const schemaStdout = createCapture();
		const schemaExitCode = await runCli(["schema", "--json"], {
			stderr: createCapture().stream,
			stdout: schemaStdout.stream
		});

		expect(schemaExitCode).toBe(0);
		expect(JSON.parse(schemaStdout.read()).planEntries).toEqual(expect.objectContaining({
			linkCommand: "agent-issues link <planEntryId> informs <targetId> --json",
			linkRelationType: "informs",
			linkTargetKind: "entity"
		}));
	});

	it("resolves help for a multi-word command like 'auth login' by its full name, not just its first word", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["help", "auth", "login", "--json"], { stderr: stderr.stream, stdout: stdout.stream });

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		const payload = JSON.parse(stdout.read());
		expect(payload.command.name).toBe("auth login");
		expect(payload.command.usage).toEqual([
			"agent-issues auth login",
			"agent-issues auth login --name <name> --url <url>"
		]);
		expect(payload.command.positionals).toBeUndefined();
		expect(payload.command.options).toContainEqual({
			name: "--name <name>",
			description: "Unique saved-login name for one-shot use. Prompted when omitted interactively."
		});
		expect(payload.command.options).toContainEqual({
			name: "--url <url>",
			description: "Remote agent-issues service URL for one-shot use. Prompted when omitted interactively."
		});
		expect(JSON.stringify(payload.command)).not.toMatch(/--local|--cloud|cloud bind|cloud unbind|cloud status/);
	});

	it("documents direct and cyclic saved-login switching", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["help", "auth", "switch", "--json"], { stderr: stderr.stream, stdout: stdout.stream });
		const command = JSON.parse(stdout.read()).command;

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(command.summary).toContain("saved login");
		expect(command.usage).toEqual(["agent-issues auth switch [name]"]);
		expect(command.positionals).toEqual([
			{
				name: "name",
				description: "Saved login to activate. Omit to advance in switching order.",
				required: false
			}
		]);
		expect(command.output.json).toEqual(["command", "login"]);
	});

	it("documents saved-login list, status, and logout", async () => {
		const readHelp = async (command: string) => {
			const stdout = createCapture();
			const exitCode = await runCli(["help", "auth", command, "--json"], {
				stderr: createCapture().stream,
				stdout: stdout.stream
			});
			expect(exitCode).toBe(0);
			return JSON.parse(stdout.read()).command;
		};

		const list = await readHelp("list");
		expect(list.summary).toContain("saved logins");
		expect(list.usage).toEqual(["agent-issues auth list"]);
		expect(list.output.json).toEqual(["command", "logins"]);

		const status = await readHelp("status");
		expect(status.summary).toContain("active saved login");
		expect(status.output.json).toEqual(["command", "login"]);

		const logout = await readHelp("logout");
		expect(logout.usage).toEqual(["agent-issues auth logout [name]"]);
		expect(logout.positionals).toEqual([
			{
				name: "name",
				description: "Remote saved login to remove. Defaults to the active saved login.",
				required: false
			}
		]);
		expect(logout.output.json).toEqual(["command", "name"]);
	});

	it("documents the ADR lifecycle in status and archive help", async () => {
		const readHelp = async (command: string) => {
			const stdout = createCapture();
			const exitCode = await runCli(["help", command, "--json"], {
				stderr: createCapture().stream,
				stdout: stdout.stream
			});
			expect(exitCode).toBe(0);
			return JSON.parse(stdout.read()).command;
		};

		const status = await readHelp("status");
		const archive = await readHelp("archive");

		expect(status.notes.join(" ")).toContain("ADR is current unless it is superseded or archived");
		expect(archive.notes.join(" ")).toContain("For an ADR, archive is refused while a supersedes edge points at it");
	});

	it("routes '--help' appended to a multi-word command through the help renderer", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["auth", "login", "--help"], { stderr: stderr.stream, stdout: stdout.stream });

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain("agent-issues auth login --name <name> --url <url>");
	});

	it("documents debt workflow help and capabilities", async () => {
		const createStdout = createCapture();
		const createExitCode = await runCli(["help", "create", "--json"], { stdout: createStdout.stream, stderr: createCapture().stream });

		expect(createExitCode).toBe(0);
		const createHelp = JSON.parse(createStdout.read()).command;
		expect(createHelp.examples).toContain(
			'agent-issues create handoff --title "Resume export work" --body-file - --link handsOff ISS1'
		);
		expect(createHelp.examples).toContain(
			'agent-issues create debt --title "Replace legacy worker" --parent INIT1 --category technical --priority high'
		);
		expect(createHelp.notes).toContain(
			"Debt requires one project, epic, initiative, or issue parent, plus category and priority."
		);
		expect(createHelp.options).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: "--category <category>" }),
			expect.objectContaining({ name: "--priority <priority>" })
		]));

		const editStdout = createCapture();
		const editExitCode = await runCli(["help", "edit", "--json"], { stdout: editStdout.stream, stderr: createCapture().stream });

		expect(editExitCode).toBe(0);
		const editHelp = JSON.parse(editStdout.read()).command;
		expect(editHelp.options).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: "--category <category>" }),
			expect.objectContaining({ name: "--priority <priority>" })
		]));

		for (const [command, expectedText] of [
			["move", "Debt can move only to a project, epic, initiative, or issue owner."],
			["status", "Debt uses open, resolved, and archived states. Its lifecycle changes are manual; a resolves link does not change its state."],
			["archive", "Archiving debt sets its lifecycle to archived. Use `status <debtId> open` to restore it."],
			["link", "Only epics, initiatives, and issues can resolve debt. A resolves link does not change debt lifecycle state."]
		]) {
			const stdout = createCapture();
			const exitCode = await runCli(["help", command, "--json"], { stdout: stdout.stream, stderr: createCapture().stream });

			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout.read()).command.notes).toContain(expectedText);
		}

		for (const [command, expectedExample] of [
			["relations", "agent-issues relations DEBT1 --direction incoming --type records,resolves --json"],
			["list", "agent-issues list debt --status open --json"]
		]) {
			const stdout = createCapture();
			const exitCode = await runCli(["help", command, "--json"], { stdout: stdout.stream, stderr: createCapture().stream });

			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout.read()).command.examples).toContain(expectedExample);
		}

		const capabilitiesStdout = createCapture();
		const capabilitiesExitCode = await runCli(["capabilities", "--json"], { stdout: capabilitiesStdout.stream, stderr: createCapture().stream });

		expect(capabilitiesExitCode).toBe(0);
		const capabilities = JSON.parse(capabilitiesStdout.read());
		expect(capabilities).not.toHaveProperty("skills");
		expect(capabilities.schema).toEqual(expect.objectContaining({
			entityCategories: ["technical", "product", "operational", "security", "process", "other"],
			entityPriorities: ["low", "medium", "high", "critical"]
		}));
	});

	it("does not expose the removed VS Code compatibility commands", async () => {
		const removedCommands = ["install-vscode", "update-vscode", "list-vscode", "uninstall-vscode"];
		const helpStdout = createCapture();

		expect(await runCli(["help", "--json"], {
			stderr: createCapture().stream,
			stdout: helpStdout.stream
		})).toBe(0);
		const commandNames = JSON.parse(helpStdout.read()).commands.map((command: { name: string }) => command.name);
		expect(commandNames).not.toEqual(expect.arrayContaining(removedCommands));

		for (const command of removedCommands) {
			await expect(runCli([command], {
				stderr: createCapture().stream,
				stdout: createCapture().stream
			})).rejects.toThrow(`Command not implemented yet: ${command}`);
		}
	});

	it.each(["list", "relations", "show"])("does not document a JSON view option for %s", async (command) => {
		const stdout = createCapture();

		const exitCode = await runCli(["help", command, "--json"], {
			stderr: createCapture().stream,
			stdout: stdout.stream
		});
		const help = JSON.parse(stdout.read()).command;

		expect(exitCode).toBe(0);
		expect((help.options ?? []).map((option: { name: string }) => option.name)).not.toContain("--view <compact|full>");
	});

	it("documents bounded list and relation filters", async () => {
		const listStdout = createCapture();
		const relationsStdout = createCapture();

		await runCli(["help", "list", "--json"], { stderr: createCapture().stream, stdout: listStdout.stream });
		await runCli(["help", "relations", "--json"], { stderr: createCapture().stream, stdout: relationsStdout.stream });
		const listHelp = JSON.parse(listStdout.read()).command;
		const relationsHelp = JSON.parse(relationsStdout.read()).command;

		expect(listHelp.options.map((option: { name: string }) => option.name)).toEqual([
			"--status <comma-separated statuses>",
			"--parent <id>",
			"--limit <count>"
		]);
		expect(relationsHelp.options.map((option: { name: string }) => option.name)).toEqual([
			"--direction <incoming|outgoing|both>",
			"--type <comma-separated types>"
		]);
		expect(listHelp.examples).toContain("agent-issues list issue --status todo,in-progress --parent <initiativeId> --limit 20 --json");
		expect(relationsHelp.examples).toContain("agent-issues relations <id> --direction incoming --type blocks,decomposes --json");
		expect(listHelp.notes).toContain("Accepted status values depend on the entity kind; use agent-issues schema --json to inspect each kind's workflow.");
	});

	it.each([
		["history", "agent-issues history <id> --revision <revision>"],
		["restore", "agent-issues restore <id> --revision <revision>"]
	])("documents %s in CLI help", async (command, usage) => {
		const stdout = createCapture();
		const exitCode = await runCli(["help", command, "--json"], { stderr: createCapture().stream, stdout: stdout.stream });

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.read()).command.usage).toContain(usage);
	});

	it("rejects read-only context acknowledgement views before opening the store", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "invalid-context-view.db");

		await expect(runCli(
			["context", "show", "--view", "compact", "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		)).rejects.toThrow("--view compact is only valid for context set, define, and forget.");
		expect(existsSync(dbPath)).toBe(false);
	});

	it("documents fixed mutation acknowledgements", async () => {
		for (const command of ["create", "edit", "archive", "delete", "move", "status", "link", "unlink"]) {
			const stdout = createCapture();
			await runCli(["help", command, "--json"], { stderr: createCapture().stream, stdout: stdout.stream });
			const help = JSON.parse(stdout.read()).command;
			expect((help.options ?? []).map((option: { name: string }) => option.name)).not.toContain("--view <compact|full>");
		}

		const contextStdout = createCapture();
		await runCli(["help", "context", "--json"], { stderr: createCapture().stream, stdout: contextStdout.stream });
		const contextHelp = JSON.parse(contextStdout.read()).command;
		expect(contextHelp.options).toContainEqual(expect.objectContaining({
			name: "--view <all|global|initiatives|compact|full>"
		}));
		expect(contextHelp.options).toContainEqual({
			name: "--scope <entityOrProjectOrInitiativeId|default>",
			description: "Resolve context from a project, an initiative, or an entity inside an initiative."
		});
	});

	it("prints compact json by default and pretty json when requested", async () => {
		const compactStdout = createCapture();
		const compactStderr = createCapture();

		const compactExitCode = await runCli(["help", "create", "--json"], {
			stderr: compactStderr.stream,
			stdout: compactStdout.stream
		});

		expect(compactExitCode).toBe(0);
		expect(compactStderr.read()).toBe("");
		expect(JSON.parse(compactStdout.read())).toBeTruthy();
		expect(compactStdout.read().trim().split("\n")).toHaveLength(1);

		const prettyStdout = createCapture();
		const prettyStderr = createCapture();

		const prettyExitCode = await runCli(["help", "create", "--json", "--pretty"], {
			stderr: prettyStderr.stream,
			stdout: prettyStdout.stream
		});

		expect(prettyExitCode).toBe(0);
		expect(prettyStderr.read()).toBe("");
		expect(JSON.parse(prettyStdout.read())).toBeTruthy();
		expect(prettyStdout.read().trim().split("\n").length).toBeGreaterThan(1);
	});

	it("prints compact json errors by default and pretty json errors when requested", async () => {
		const originalWrite = process.stderr.write.bind(process.stderr);
		const chunks: string[] = [];

		process.stderr.write = ((chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}) as typeof process.stderr.write;

		try {
			const compactExitCode = await main(["show", "--json"]);

			expect(compactExitCode).toBe(1);
			expect(JSON.parse(chunks.join(""))).toHaveProperty("error");
			expect(chunks.join("").trim().split("\n")).toHaveLength(1);

			chunks.length = 0;

			const prettyExitCode = await main(["show", "--json", "--pretty"]);

			expect(prettyExitCode).toBe(1);
			expect(JSON.parse(chunks.join(""))).toHaveProperty("error");
			expect(chunks.join("").trim().split("\n").length).toBeGreaterThan(1);
		} finally {
			process.stderr.write = originalWrite;
		}
	});

	it("treats a symlinked argv path as a direct invocation", async () => {
		const root = createTempDir();
		const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
		const linkedPath = path.join(root, "agent-issues");

		symlinkSync(cliPath, linkedPath);

		expect(isEntrypointInvocation(pathToFileURL(cliPath).href, linkedPath)).toBe(true);
	});

	it("recognizes the hidden daemon-spawn flag as the first argument (ISS190)", () => {
		expect(shouldRunLocalDaemon([LOCAL_DAEMON_SPAWN_FLAG])).toBe(true);
	});

	it("does not treat an ordinary command as the daemon-spawn flag", () => {
		expect(shouldRunLocalDaemon(["list", "initiative"])).toBe(false);
		expect(shouldRunLocalDaemon([])).toBe(false);
	});

	it("recognizes the hidden MCP server flag as the first argument", () => {
		expect(shouldRunMcpServer([MCP_SERVER_FLAG])).toBe(true);
		expect(shouldRunMcpServer(["list", "initiative"])).toBe(false);
	});

	it.each(["--version", "-v"])("prints the installed package version for %s", async (versionFlag) => {
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli([versionFlag], { stderr: stderr.stream, stdout: stdout.stream });

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toBe(`${packageJson.version}\n`);
	});

	it("creates entities through clipanion-parsed options", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(
			["create", "initiative", "--title", "Ship clipanion", "--db", dbPath],
			{ cwd: root, stderr: stderr.stream, stdout: stdout.stream }
		);

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain("initiative");

		const { db, executor } = await ensureDatabase(dbPath);
		try {
			const initiatives = listEntities(executor, "initiative");
			expect(initiatives).toHaveLength(1);
			expect(initiatives[0]?.title).toBe("Ship clipanion");
		} finally {
			db.close();
		}
	});

	it("creates debt with required metadata through the CLI", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath);
		const owner = createEntity(executor, { kind: "project", title: "Platform" });
		db.close();
		const stdout = createCapture();

		const exitCode = await runCli([
			"create", "debt", "--title", "Replace deprecated API", "--parent", owner.id,
			"--category", "technical", "--priority", "high", "--project-identity", owner.id, "--db", dbPath, "--json"
		], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });

		expect(exitCode).toBe(0);
		const created = JSON.parse(stdout.read()) as { reference: string };
		const detailsOutput = createCapture();
		await runCli(["show", created.reference, "--project-identity", owner.id, "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: detailsOutput.stream });
		expect(JSON.parse(detailsOutput.read())).toMatchObject({ entity: { reference: expect.stringMatching(/^DEBT_/), category: "technical", priority: "high" } });
	});

	it("creates typed Pioneer issues through the CLI", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath);
		const initiative = createEntity(executor, { kind: "initiative", title: "Pioneer" });
		db.close();
		const stdout = createCapture();

		const exitCode = await runCli([
			"create", "issue", "--title", "Choose architecture", "--parent", initiative.reference,
			"--type", "pioneer-map", "--db", dbPath, "--json"
		], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });

		expect(exitCode).toBe(0);
		const created = JSON.parse(stdout.read()) as { reference: string };
		const detailsOutput = createCapture();
		await runCli(["show", created.reference, "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: detailsOutput.stream });
		expect(JSON.parse(detailsOutput.read())).toMatchObject({ entity: { type: "pioneer-map" } });
	});

	it("rejects debt creation without all required metadata through the CLI", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath);
		const owner = createEntity(executor, { kind: "project", title: "Platform" });
		db.close();

		await expect(runCli([
			"create", "debt", "--title", "Replace deprecated API", "--parent", owner.id,
			"--category", "technical", "--db", dbPath
		], { cwd: root, stderr: createCapture().stream, stdout: createCapture().stream })).rejects.toThrow(
			"Debt requires category and priority."
		);
	});

	it("edits debt metadata independently through the CLI", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath);
		const owner = createEntity(executor, { kind: "project", title: "Platform" });
		const debt = createEntity(executor, {
			kind: "debt",
			title: "Replace deprecated API",
			parentId: owner.id,
			category: "technical",
			priority: "high"
		});
		db.close();
		const stdout = createCapture();

		const exitCode = await runCli([
			"edit", debt.reference, "--priority", "critical", "--project-identity", owner.id, "--db", dbPath, "--json"
		], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.read())).toEqual({ operation: "edit", reference: debt.reference, revision: 2 });
		const detailsOutput = createCapture();
		await runCli(["show", debt.reference, "--project-identity", owner.id, "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: detailsOutput.stream });
		expect(JSON.parse(detailsOutput.read())).toMatchObject({ entity: { category: "technical", priority: "critical" } });
	});

	it("edits an entity category without changing its priority through the CLI", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath);
		const initiative = createEntity(executor, {
			kind: "initiative",
			title: "Platform",
			category: "technical",
			priority: "high"
		});
		db.close();
		const stdout = createCapture();

		const exitCode = await runCli([
			"edit", initiative.reference, "--category", "product", "--db", dbPath, "--json"
		], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.read())).toEqual({ operation: "edit", reference: initiative.reference, revision: 2 });
		const detailsOutput = createCapture();
		await runCli(["show", initiative.reference, "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: detailsOutput.stream });
		expect(JSON.parse(detailsOutput.read())).toMatchObject({ initiative: { category: "product", priority: "high" } });
	});

	it("prints the canonical reference after creating a handoff", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const stdout = createCapture();

		await runCli(
			["create", "handoff", "--title", "Resume migration work", "--db", dbPath],
			{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
		);

		expect(stdout.read()).toMatch(/^HO_[0-9A-HJKMNP-TV-Z]{26} handoff active Resume migration work\n$/);
	});

	it("returns compact create and edit acknowledgements without authored bodies", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createBody = "Create body that must not be echoed. ".repeat(200);
		const editBody = "Edit body that must not be echoed. ".repeat(200);
		const createStdout = createCapture();

		await runCli([
			"create", "issue",
			"--title", "Compact mutation",
			"--body-file", writeBodyFile(root, createBody),
			"--db", dbPath,
			"--json"
		], { cwd: root, stderr: createCapture().stream, stdout: createStdout.stream });
		const created = JSON.parse(createStdout.read()) as { reference: string; revision: number };

		expect(created).toEqual({
			operation: "create",
			id: expect.stringMatching(/^[0-9a-f-]{36}$/),
			reference: expect.stringMatching(/^ISS_/),
			status: "todo",
			revision: 1
		});
		expect(createStdout.read()).not.toContain(createBody);

		const editStdout = createCapture();
		await runCli([
			"edit", created.reference,
			"--body-file", writeBodyFile(root, editBody),
			"--db", dbPath,
			"--json"
		], { cwd: root, stderr: createCapture().stream, stdout: editStdout.stream });

		expect(JSON.parse(editStdout.read())).toEqual({
			operation: "edit",
			reference: created.reference,
			revision: 2
		});
		expect(editStdout.read()).not.toContain(editBody);

		const acknowledgementStdout = createCapture();
		await runCli([
			"edit", created.reference,
			"--title", "Full mutation",
			"--db", dbPath,
			"--json"
		], { cwd: root, stderr: createCapture().stream, stdout: acknowledgementStdout.stream });
		expect(JSON.parse(acknowledgementStdout.read())).toEqual({
			operation: "edit",
			reference: created.reference,
			revision: 3
		});
	});

	it("returns compact lifecycle acknowledgements while preserving human output", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createJson = async (kind: string, title: string, parent?: string) => {
			const stdout = createCapture();
			await runCli([
				"create", kind, "--title", title,
				...(parent ? ["--parent", parent] : []),
				"--db", dbPath, "--json"
			], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });
			return JSON.parse(stdout.read()) as { id: string; reference: string };
		};
		const firstParent = await createJson("initiative", "First parent");
		const secondParent = await createJson("initiative", "Second parent");
		const issue = await createJson("issue", "Lifecycle issue", firstParent.id);
		const statusStdout = createCapture();
		await runCli(["status", issue.reference, "in-progress", "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: statusStdout.stream });
		expect(JSON.parse(statusStdout.read())).toEqual({
			operation: "status",
			reference: issue.reference,
			previousStatus: "todo",
			status: "in-progress",
			revision: 2
		});

		const moveStdout = createCapture();
		await runCli(["move", issue.reference, secondParent.reference, "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: moveStdout.stream });
		expect(JSON.parse(moveStdout.read())).toEqual(expect.objectContaining({
			operation: "move",
			reference: issue.reference,
			newParentId: secondParent.id,
			type: "tracks",
			revision: 3
		}));

		const archiveStdout = createCapture();
		await runCli(["archive", issue.reference, "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: archiveStdout.stream });
		expect(JSON.parse(archiveStdout.read())).toEqual({
			operation: "archive",
			reference: issue.reference,
			previousStatus: "in-progress",
			status: "done",
			revision: 4
		});

		const statusNoopStdout = createCapture();
		await runCli(["status", issue.reference, "done", "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: statusNoopStdout.stream });
		expect(JSON.parse(statusNoopStdout.read())).toEqual(expect.objectContaining({
			operation: "status",
			reference: issue.reference,
			previousStatus: "done",
			status: "done"
		}));

		const humanStdout = createCapture();
		await runCli(["status", issue.reference, "done", "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: humanStdout.stream });
		expect(humanStdout.read()).toContain(`Updated ${issue.id} from done to done`);

		const deleteStdout = createCapture();
		await runCli(["delete", issue.reference, "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: deleteStdout.stream });
		expect(JSON.parse(deleteStdout.read())).toEqual({ operation: "delete", reference: issue.reference, removed: true });
	});

	it("records a workspace observation when the status command completes an issue", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createStdout = createCapture();
		await runCli(["create", "issue", "--title", "Observed completion", "--db", dbPath, "--json"], {
			cwd: root,
			stderr: createCapture().stream,
			stdout: createStdout.stream
		});
		const issue = JSON.parse(createStdout.read()) as { id: string };

		await runCli(["status", issue.id, "done", "--db", dbPath], {
			cwd: root,
			stderr: createCapture().stream,
			stdout: createCapture().stream
		});

		const { store } = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		try {
			expect((await store.getEntityDetails(issue.id)).completionObservations).toEqual([
				expect.objectContaining({
					completionOrdinal: 1,
					calculatedVersionState: "unknown",
					diagnostics: [{ code: "workspace-observation-failed", message: expect.any(String) }]
				})
			]);
		} finally {
			await store.close();
		}
	});

	it("returns compact relation acknowledgements for successful and no-op writes", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createJson = async (title: string) => {
			const stdout = createCapture();
			await runCli(["create", "issue", "--title", title, "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });
			return JSON.parse(stdout.read()) as { id: string; reference: string };
		};
		const source = await createJson("Source");
		const target = await createJson("Target");
		const runRelation = async (command: "link" | "unlink") => {
			const stdout = createCapture();
			await runCli([command, source.reference, "blocks", target.reference, "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });
			return JSON.parse(stdout.read());
		};

		expect(await runRelation("link")).toEqual({ operation: "link", fromId: source.id, toId: target.id, type: "blocks", created: true });
		expect(await runRelation("link")).toEqual({ operation: "link", fromId: source.id, toId: target.id, type: "blocks", created: false });
		expect(await runRelation("unlink")).toEqual({ operation: "unlink", fromId: source.id, toId: target.id, type: "blocks", removed: true });
	});

	it("returns a compact context set acknowledgement without authored content", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const summary = "Context summary that must not be echoed. ".repeat(100);
		const runJson = async (args: string[]) => {
			const stdout = createCapture();
			await runCli([...args, "--view", "compact", "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });
			const output = stdout.read();
			return { output, value: JSON.parse(output) };
		};

		const set = await runJson(["context", "set", "--title", "Compact context", "--body-file", writeBodyFile(root, summary)]);
		expect(set.value).toEqual({ operation: "context-set", reference: expect.stringMatching(/^CTX_/), revision: 1 });
		expect(set.output).not.toContain(summary);
	});

	it("returns a compact context definition acknowledgement without authored content", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const definition = "Term definition that must not be echoed. ".repeat(100);
		const runJson = async (args: string[]) => {
			const stdout = createCapture();
			await runCli([...args, "--view", "compact", "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });
			const output = stdout.read();
			return { output, value: JSON.parse(output) };
		};

		const set = await runJson(["context", "set", "--title", "Compact context", "--body-file", writeBodyFile(root, "Context summary")]);

		const define = await runJson(["context", "define", "Order", "--body-file", writeBodyFile(root, definition)]);
		expect(define.value).toEqual(expect.objectContaining({ operation: "context-define", contextReference: set.value.reference, term: "Order", created: true, revision: 1 }));
		expect(define.output).not.toContain(definition);
	});

	it("returns a compact context definition update acknowledgement", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const runJson = async (args: string[]) => {
			const stdout = createCapture();
			await runCli([...args, "--view", "compact", "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });
			return JSON.parse(stdout.read());
		};

		await runJson(["context", "set", "--title", "Compact context", "--body-file", writeBodyFile(root, "Context summary")]);
		await runJson(["context", "define", "Order", "--body-file", writeBodyFile(root, "Term definition")]);
		const redefine = await runJson(["context", "define", "Order", "--body-file", writeBodyFile(root, "Updated definition")]);
		expect(redefine).toEqual(expect.objectContaining({ operation: "context-define", term: "Order", created: false, revision: 2 }));
	});

	it("returns a compact context term removal acknowledgement", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const runJson = async (args: string[]) => {
			const stdout = createCapture();
			await runCli([...args, "--view", "compact", "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });
			return JSON.parse(stdout.read());
		};

		const set = await runJson(["context", "set", "--title", "Compact context", "--body-file", writeBodyFile(root, "Context summary")]);
		await runJson(["context", "define", "Order", "--body-file", writeBodyFile(root, "Term definition")]);
		const forget = await runJson(["context", "forget", "Order"]);
		expect(forget).toEqual(expect.objectContaining({ operation: "context-forget", reference: set.reference, term: "Order", removed: true }));
	});

	it("returns a compact no-op context term removal acknowledgement", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const runJson = async (args: string[]) => {
			const stdout = createCapture();
			await runCli([...args, "--view", "compact", "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });
			return JSON.parse(stdout.read());
		};

		const set = await runJson(["context", "set", "--title", "Compact context", "--body-file", writeBodyFile(root, "Context summary")]);
		await runJson(["context", "define", "Order", "--body-file", writeBodyFile(root, "Term definition")]);
		const forget = await runJson(["context", "forget", "Order"]);
		const forgetNoop = await runJson(["context", "forget", "Order"]);
		expect(forget).toEqual(expect.objectContaining({ operation: "context-forget", reference: set.reference, term: "Order", removed: true }));
		expect(forgetNoop).toEqual(expect.objectContaining({ operation: "context-forget", reference: set.reference, term: "Order", removed: false }));
	});

	it("returns compact context restoration acknowledgements", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const runJson = async (args: string[]) => {
			const stdout = createCapture();
			await runCli([...args, "--view", "compact", "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });
			return JSON.parse(stdout.read());
		};

		await runJson(["context", "set", "--title", "Compact context", "--body-file", writeBodyFile(root, "Context summary")]);
		const contextRestore = await runJson(["restore", "--context", "default", "--revision", "1"]);
		expect(contextRestore).toEqual({ operation: "context-restore", contextKey: "default", revision: 2, restoredFromRevision: 1 });
	});

	it("returns a compact context term restoration acknowledgement", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const runJson = async (args: string[]) => {
			const stdout = createCapture();
			await runCli([...args, "--view", "compact", "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });
			return JSON.parse(stdout.read());
		};

		await runJson(["context", "set", "--title", "Compact context", "--body-file", writeBodyFile(root, "Context summary")]);
		await runJson(["context", "define", "Order", "--body-file", writeBodyFile(root, "Term definition")]);
		const termRestore = await runJson(["restore", "--context", "default", "--term", "Order", "--revision", "1"]);
		expect(termRestore).toEqual(expect.objectContaining({ operation: "context-term-restore", contextKey: "default", term: "Order", restoredFromRevision: 1 }));
	});

	it("returns a compact entity restoration acknowledgement", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		let entity;
		try {
			entity = await store.createEntity({ kind: "issue", title: "Original", body: "Original body" });
			await store.updateEntity({
				entityId: entity.id,
				title: "Edited",
				expectedRevision: entity.revision,
				expectedContentHash: entity.contentHash
			});
		} finally {
			await store.close();
		}
		const entityRestoreOutput = createCapture();
		await runCli(["restore", entity!.reference, "--revision", "1", "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: entityRestoreOutput.stream });
		expect(JSON.parse(entityRestoreOutput.read())).toEqual({
			operation: "restore",
			id: entity!.id,
			revision: 3,
			restoredFromRevision: 1
		});
	});

	it.each([
		["create", "issue", "--title", "Invalid view"],
		["edit", "missing", "--title", "Invalid view"],
		["archive", "missing"],
		["delete", "missing"],
		["move", "missing", "parent"],
		["status", "missing", "done"],
		["link", "from", "blocks", "to"],
		["unlink", "from", "blocks", "to"],
		["restore", "missing", "--revision", "1"]
	])("rejects removed entity mutation view options before opening the store", async (...command) => {
		const root = createTempDir();
		const dbPath = path.join(root, "invalid-mutation-view.db");

		await expect(runCli(
			[...command, "--view", "summary", "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		)).rejects.toThrow(/--view/);
		expect(existsSync(dbPath)).toBe(false);
	});

	it.each([
		["context", "set", "--title", "Invalid", "--body-file", "irrelevant.md"],
		["context", "define", "Term", "--body-file", "irrelevant.md"],
		["context", "forget", "Term"]
	])("rejects an invalid context mutation view before opening the store", async (...command) => {
		const root = createTempDir();
		const dbPath = path.join(root, "invalid-context-mutation-view.db");

		await expect(runCli(
			[...command, "--view", "summary", "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		)).rejects.toThrow("Unknown entity view: summary");
		expect(existsSync(dbPath)).toBe(false);
	});

	it("lists populated compact JSON as items and total", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createStdout = createCapture();

		const createExitCode = await runCli(
			["create", "issue", "--title", "Compact list issue", "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: createStdout.stream }
		);
		const created = JSON.parse(createStdout.read()) as { id: string; reference: string };
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(
			["list", "issue", "--db", dbPath, "--json"],
			{ cwd: root, stderr: stderr.stream, stdout: stdout.stream }
		);

		expect(createExitCode).toBe(0);
		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(JSON.parse(stdout.read())).toEqual({
			items: [{
				id: created.id,
				reference: created.reference,
				kind: "issue",
				status: "todo",
				title: "Compact list issue"
			}],
			total: 1,
			openBlockers: { [created.reference]: [] }
		});
	});

	it("keeps compact JSON list output for an unambiguous short parent reference", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const create = async (kind: string, title: string, parent?: string) => {
			const stdout = createCapture();
			await runCli(
				["create", kind, "--title", title, ...(parent ? ["--parent", parent] : []), "--db", dbPath, "--json"],
				{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
			);
			return JSON.parse(stdout.read()) as { id: string; reference: string; kind: string; status: string; title: string };
		};
		const initiative = await create("initiative", "Short parent");
		const issue = await create("issue", "Grouped child", initiative.reference);
		const stdout = createCapture();

		await runCli(
			["list", "issue", "--parent", shortEntityReference({ id: initiative.id, kind: "initiative" }), "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
		);

		expect(JSON.parse(stdout.read())).toMatchObject({
			items: [expect.objectContaining({ id: issue.id })]
		});
		expect(JSON.parse(stdout.read()).parentGroups).toBeUndefined();
	});

	it("lists empty compact JSON as empty items and zero total", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(
			["list", "issue", "--db", dbPath, "--json"],
			{ cwd: root, stderr: stderr.stream, stdout: stdout.stream }
		);

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(JSON.parse(stdout.read())).toEqual({ items: [], total: 0, openBlockers: {} });
	});

	it("reports open blockers inline on a compact issue list, excluding done blockers", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createIssue = async (title: string): Promise<{ id: string; reference: string }> => {
			const stdout = createCapture();
			await runCli(
				["create", "issue", "--title", title, "--db", dbPath, "--json"],
				{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
			);
			return JSON.parse(stdout.read()) as { id: string; reference: string };
		};
		const doneBlocker = await createIssue("Done blocker");
		const openBlocker = await createIssue("Open blocker");
		const blocked = await createIssue("Blocked issue");
		await runCli(["status", doneBlocker.id, "done", "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: createCapture().stream });
		await runCli(["link", doneBlocker.id, "blocks", blocked.id, "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: createCapture().stream });
		await runCli(["link", openBlocker.id, "blocks", blocked.id, "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: createCapture().stream });

		const stdout = createCapture();
		const exitCode = await runCli(
			["list", "issue", "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
		);

		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout.read()) as { openBlockers: Record<string, string[]> };
		expect(result.openBlockers[blocked.reference]).toEqual([openBlocker.reference]);
		expect(result.openBlockers[openBlocker.reference]).toEqual([]);
		expect(result.openBlockers[doneBlocker.reference]).toEqual([]);
	});

	it("lists next work with available leaf issues before decomposition and block dependencies", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const create = async (kind: string, title: string, parent?: string): Promise<{ id: string; reference: string }> => {
			const stdout = createCapture();
			await runCli(
				["create", kind, "--title", title, ...(parent ? ["--parent", parent] : []), "--db", dbPath, "--json"],
				{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
			);
			return JSON.parse(stdout.read()) as { id: string; reference: string };
		};
		const initiative = await create("initiative", "Next work scope");
		const parent = await create("issue", "Release validation", initiative.reference);
		const prerequisite = await create("issue", "Publish results", initiative.reference);
		const child = await create("issue", "Approve limits", parent.reference);
		const independent = await create("issue", "Write release notes", initiative.reference);
		const deferred = await create("issue", "Later work", initiative.reference);
		const deferredChild = await create("issue", "Optional child", independent.reference);
		for (const issue of [deferred, deferredChild]) {
			await runCli(["status", issue.reference, "deferred", "--db", dbPath, "--json"], { cwd: root, stderr: createCapture().stream, stdout: createCapture().stream });
		}
		await runCli(["link", prerequisite.reference, "blocks", child.reference, "--db", dbPath, "--json"], {
			cwd: root,
			stderr: createCapture().stream,
			stdout: createCapture().stream
		});
		const stdout = createCapture();

		const exitCode = await runCli(
			["next-work", parent.reference, "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
		);

		expect(exitCode).toBe(0);
		const work = JSON.parse(stdout.read()) as { available: Array<{ issue: { reference: string } }>; blocked: Array<{ issue: { reference: string } }> };
		expect(work.available.map((item) => item.issue.reference).sort()).toEqual([prerequisite.reference, independent.reference].sort());
		expect(work.blocked.map((item) => item.issue.reference).sort()).toEqual([child.reference, parent.reference].sort());
		expect(JSON.parse(stdout.read())).toEqual({
			initiative: expect.objectContaining({ reference: initiative.reference }),
			available: expect.arrayContaining([
				expect.objectContaining({ issue: expect.objectContaining({ reference: prerequisite.reference }), blockers: [], unblocks: [child.reference] }),
				expect.objectContaining({ issue: expect.objectContaining({ reference: independent.reference }), blockers: [], unblocks: [] })
			]),
			blocked: expect.arrayContaining([
				expect.objectContaining({ issue: expect.objectContaining({ reference: child.reference }), blockers: [prerequisite.reference], unblocks: [parent.reference] }),
				expect.objectContaining({ issue: expect.objectContaining({ reference: parent.reference }), blockers: [child.reference], unblocks: [] })
			])
		});
	});

	it("combines list filters and preserves the filtered total when results are limited", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createJson = async (args: string[]): Promise<{ id: string; reference: string }> => {
			const stdout = createCapture();
			await runCli([...args, "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: stdout.stream
			});
			return JSON.parse(stdout.read()) as { id: string; reference: string };
		};
		const selectedParent = await createJson(["create", "initiative", "--title", "Selected parent"]);
		const otherParent = await createJson(["create", "initiative", "--title", "Other parent"]);
		await createJson(["create", "issue", "--title", "Selected todo", "--parent", selectedParent.id]);
		await createJson(["create", "issue", "--title", "Selected active", "--parent", selectedParent.id, "--status", "in-progress"]);
		await createJson(["create", "issue", "--title", "Other todo", "--parent", otherParent.id]);
		const stdout = createCapture();

		const exitCode = await runCli([
			"list", "issue",
			"--status", "todo,in-progress",
			"--parent", selectedParent.reference,
			"--limit", "1",
			"--db", dbPath,
			"--json"
		], { cwd: root, stderr: createCapture().stream, stdout: stdout.stream });

		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout.read()) as { items: Array<{ title: string }>; total: number };
		expect(result.items).toHaveLength(1);
		expect(["Selected todo", "Selected active"]).toContain(result.items[0]?.title);
		expect(result.total).toBe(2);

		const emptyStdout = createCapture();
		await runCli([
			"list", "issue",
			"--parent", otherParent.reference,
			"--status", "in-progress",
			"--db", dbPath,
			"--json"
		], { cwd: root, stderr: createCapture().stream, stdout: emptyStdout.stream });
		expect(JSON.parse(emptyStdout.read())).toEqual({ items: [], total: 0, openBlockers: {} });
	});

	it("returns summary list JSON without authored content", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		await runCli(
			["create", "issue", "--title", "Full list issue", "--body-file", writeBodyFile(root, "Full body"), "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		);
		const defaultStdout = createCapture();
		const exitCode = await runCli(
			["list", "issue", "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: defaultStdout.stream }
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(defaultStdout.read())).toEqual({
			items: [expect.objectContaining({ kind: "issue", status: "todo", title: "Full list issue" })],
			total: 1,
			openBlockers: expect.any(Object)
		});
		expect(JSON.parse(defaultStdout.read()).items[0]).not.toHaveProperty("body");
	});

	it.each(["full", "summary"])("rejects removed list view %s before opening the store", async (view) => {
		const root = createTempDir();
		const dbPath = path.join(root, "invalid-view.db");

		await expect(runCli(
			["list", "issue", "--db", dbPath, "--json", "--view", view],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		)).rejects.toThrow(/--view/);
		expect(existsSync(dbPath)).toBe(false);
	});

	it.each(["relations", "show"])("rejects removed %s view options before opening the store", async (command) => {
		const root = createTempDir();
		const dbPath = path.join(root, `${command}-invalid-view.db`);

		await expect(runCli(
			[command, "missing-entity", "--db", dbPath, "--json", "--view", "full"],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		)).rejects.toThrow(/--view/);
		expect(existsSync(dbPath)).toBe(false);
	});

	it("renders compact relations with mixed incoming and outgoing edges", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createJson = async (kind: string, title: string): Promise<{ id: string; reference: string }> => {
			const stdout = createCapture();
			await runCli(
				["create", kind, "--title", title, "--db", dbPath, "--json"],
				{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
			);
			return JSON.parse(stdout.read()) as { id: string; reference: string };
		};
		const blocker = await createJson("issue", "Blocking issue");
		const issue = await createJson("issue", "Focused issue");
		const story = await createJson("userStory", "Fixed story");
		await runCli(["link", blocker.id, "blocks", issue.id, "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: createCapture().stream });
		await runCli(["link", issue.id, "fixes", story.id, "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: createCapture().stream });
		const stdout = createCapture();

		const exitCode = await runCli(
			["relations", issue.id, "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.read())).toEqual({
			entity: { id: issue.id, reference: issue.reference, kind: "issue", status: "todo", title: "Focused issue" },
			incoming: [{ type: "blocks", entity: { id: blocker.id, reference: blocker.reference, kind: "issue", status: "todo", title: "Blocking issue" } }],
			outgoing: [{ type: "fixes", entity: { id: story.id, reference: story.reference, kind: "userStory", status: "ready", title: "Fixed story" } }],
			planEntries: []
		});
	});

	it("filters relations by direction and comma-separated types", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createJson = async (kind: string, title: string): Promise<{ id: string; reference: string }> => {
			const stdout = createCapture();
			await runCli(["create", kind, "--title", title, "--db", dbPath, "--json"], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: stdout.stream
			});
			return JSON.parse(stdout.read()) as { id: string; reference: string };
		};
		const blocker = await createJson("issue", "Blocking issue");
		const issue = await createJson("issue", "Focused issue");
		const story = await createJson("userStory", "Fixed story");
		await runCli(["link", blocker.id, "blocks", issue.id, "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: createCapture().stream });
		await runCli(["link", issue.id, "fixes", story.id, "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: createCapture().stream });
		const outgoingStdout = createCapture();
		const emptyStdout = createCapture();

		await runCli([
			"relations", issue.id,
			"--direction", "outgoing",
			"--type", "fixes,blocks",
			"--db", dbPath,
			"--json"
		], { cwd: root, stderr: createCapture().stream, stdout: outgoingStdout.stream });
		await runCli([
			"relations", issue.id,
			"--direction", "incoming",
			"--type", "fixes",
			"--db", dbPath,
			"--json"
		], { cwd: root, stderr: createCapture().stream, stdout: emptyStdout.stream });

		expect(JSON.parse(outgoingStdout.read())).toEqual({
			entity: { id: issue.id, reference: issue.reference, kind: "issue", status: "todo", title: "Focused issue" },
			incoming: [],
			outgoing: [{ type: "fixes", entity: { id: story.id, reference: story.reference, kind: "userStory", status: "ready", title: "Fixed story" } }],
			planEntries: []
		});
		expect(JSON.parse(emptyStdout.read())).toEqual({
			entity: { id: issue.id, reference: issue.reference, kind: "issue", status: "todo", title: "Focused issue" },
			incoming: [],
			outgoing: [],
			planEntries: []
		});
	});

	it.each([
		{ command: ["list", "issue", "--status", "unknown"], message: "Invalid issue status: unknown" },
		{ command: ["list", "issue", "--limit", "0"], message: "--limit must be a positive integer: 0" },
		{ command: ["relations", "missing", "--direction", "sideways"], message: "Unknown relation direction: sideways" },
		{ command: ["relations", "missing", "--type", "unknown"], message: "Unknown relation type: unknown" }
	])("rejects invalid entity filter values before opening the store", async ({ command, message }) => {
		const root = createTempDir();
		const dbPath = path.join(root, "invalid-filter.db");

		await expect(runCli(
			[...command, "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		)).rejects.toThrow(message);
		expect(existsSync(dbPath)).toBe(false);
	});

	it("reports valid relation types when a link uses an invalid type", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "invalid-link.db");
		const { store } = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		const initiative = await store.createEntity({ kind: "initiative", title: "Link owner" });
		const issue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Tracked issue" });
		await store.close();

		await expect(runCli(["link", initiative.reference, "informs", issue.reference, "--db", dbPath, "--json"], {
			cwd: root,
			stderr: createCapture().stream,
			stdout: createCapture().stream
		})).rejects.toThrow("Relation informs is not allowed from initiative to issue. Valid relation types: tracks.");
	});

	it("returns complete non-initiative show details", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createStdout = createCapture();
		await runCli(
			["create", "issue", "--title", "Ordinary compact show", "--body-file", writeBodyFile(root, "Hidden body"), "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: createStdout.stream }
		);
		const issue = JSON.parse(createStdout.read()) as { id: string; reference: string };
		const stdout = createCapture();

		const exitCode = await runCli(
			["show", issue.id, "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.read())).toMatchObject({
			entity: { id: issue.id, reference: issue.reference, body: "Hidden body", bodySource: "authored" },
			incoming: [],
			outgoing: [],
			planEntries: []
		});
	});

	it("renders the type in typed issue detail output", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath);
		const initiative = createEntity(executor, { kind: "initiative", title: "Pioneer owner" });
		const issue = createEntity(executor, {
			kind: "issue",
			parentId: initiative.id,
			title: "Choose architecture",
			type: "pioneer-map"
		});
		db.close();
		const stdout = createCapture();

		const exitCode = await runCli(
			["show", issue.reference, "--db", dbPath],
			{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
		);

		expect(exitCode).toBe(0);
		expect(stdout.read()).toContain(`${issue.reference} issue pioneer-map todo Choose architecture`);
	});

	it("keeps ordinary issue detail output unchanged", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath);
		const issue = createEntity(executor, { kind: "issue", title: "Ordinary issue" });
		db.close();
		const stdout = createCapture();

		const exitCode = await runCli(
			["show", issue.reference, "--db", dbPath],
			{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
		);

		expect(exitCode).toBe(0);
		expect(stdout.read()).toContain(`${issue.reference} issue todo Ordinary issue`);
	});

	it("shows generated current Plan entries and chronological history", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		const initiative = await store.createEntity({ kind: "initiative", title: "Plan owner" });
		const plan = await store.createEntity({ kind: "plan", parentId: initiative.id, title: "Generated Plan" });
		const question = await store.createPlanEntry({ planId: plan.id, role: "question", body: "Which view should the CLI show?" });
		const referencedIssue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Referenced issue" });
		const decision = await store.createPlanEntry({
			planId: plan.id,
			role: "decision",
			body: "Show active groups and complete history.",
			referencedEntityIds: [referencedIssue.id],
			supersededEntryIds: [question.id]
		});
		const deleted = await store.createPlanEntry({ planId: plan.id, role: "consideration", body: "Keep deleted history." });
		await store.deletePlanEntry({ entryId: deleted.id, expectedRevision: deleted.revision, expectedContentHash: deleted.contentHash });
		await store.close();
		const stdout = createCapture();

		expect(await runCli(["show", plan.reference, "--db", dbPath, "--json"], {
			cwd: root,
			stderr: createCapture().stream,
			stdout: stdout.stream
		})).toBe(0);

		const result = JSON.parse(stdout.read());
		expect(result.current.map((group: { key: string; entries: Array<{ id: string }> }) => [group.key, group.entries.map((entry) => entry.id)])).toEqual([
			["questions", []],
			["decisions", [decision.id]],
			["includedScope", []],
			["excludedScope", []],
			["constraints", []],
			["preferences", []],
			["considerations", []]
		]);
		expect(result.history.map((entry: { id: string }) => entry.id)).toEqual([question.id, decision.id, deleted.id]);
		const text = createCapture();
		expect(await runCli(["show", plan.reference, "--db", dbPath], {
			cwd: root,
			stderr: createCapture().stream,
			stdout: text.stream
		})).toBe(0);
		expect(text.read()).toContain(`supersedes ${question.reference}`);
		expect(text.read()).toContain(`references ${referencedIssue.id}`);
	});

	it("links and unlinks a Plan entry to a PRD as informs", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		const initiative = await store.createEntity({ kind: "initiative", title: "Plan entry link owner" });
		const plan = await store.createEntity({ kind: "plan", parentId: initiative.id, title: "Linked Plan" });
		const entry = await store.createPlanEntry({ planId: plan.id, role: "question", body: "Which PRD captures this decision?" });
		const prd = await store.createEntity({ kind: "prd", parentId: initiative.id, title: "Decision product requirement" });
		await store.close();
		const stdout = createCapture();

		expect(await runCli(["link", entry.reference, "informs", prd.reference, "--db", dbPath, "--json"], {
			cwd: root,
			stderr: createCapture().stream,
			stdout: stdout.stream
		})).toBe(0);
		expect(JSON.parse(stdout.read())).toMatchObject({ created: true });
		const duplicate = createCapture();
		expect(await runCli(["link", entry.reference, "informs", prd.reference, "--db", dbPath, "--json"], {
			cwd: root,
			stderr: createCapture().stream,
			stdout: duplicate.stream
		})).toBe(0);
		expect(JSON.parse(duplicate.read())).toMatchObject({ created: false });

		const { store: linkedStore } = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		try {
			expect((await linkedStore.listPlanEntries({ planId: plan.id })).find((candidate) => candidate.id === entry.id)).toMatchObject({
				referencedEntityIds: [prd.id]
			});
		} finally {
			await linkedStore.close();
		}

		const unlink = createCapture();
		expect(await runCli(["unlink", entry.reference, "informs", prd.reference, "--db", dbPath, "--json"], {
			cwd: root,
			stderr: createCapture().stream,
			stdout: unlink.stream
		})).toBe(0);
		expect(JSON.parse(unlink.read())).toMatchObject({ removed: true });
		await expect(runCli(["link", entry.reference, "blocks", prd.reference, "--db", dbPath, "--json"], {
			cwd: root,
			stderr: createCapture().stream,
			stdout: createCapture().stream
		})).rejects.toThrow("Plan entries can link to entities only as informs.");
	});

	it("returns a complete initiative-wide read from show", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const createStdout = createCapture();
		await runCli(
			["create", "initiative", "--title", "Initiative compact show", "--body-file", writeBodyFile(root, "Hidden initiative body"), "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: createStdout.stream }
		);
		const initiative = JSON.parse(createStdout.read()) as { id: string; reference: string };
		const stdout = createCapture();

		const exitCode = await runCli(
			["show", initiative.id, "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
		);
		const payload = JSON.parse(stdout.read());

		expect(exitCode).toBe(0);
		expect(Object.keys(payload)).toEqual([
			"initiative", "entities", "prds", "userStories", "adrs", "issues",
			"fixLinks", "subIssueLinks", "blockerLinks", "constrainsLinks", "versionCoverage"
		]);
		expect(payload.initiative).toMatchObject({
			id: initiative.id,
			reference: initiative.reference,
			body: "Hidden initiative body",
			bodySource: "authored"
		});
		expect(payload.versionCoverage).toEqual([]);
		expect(payload.entities.every((record: object) => Object.hasOwn(record, "body"))).toBe(true);
	});

	it("rejects the removed bundle command", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		await expect(runCli(
			["bundle", "INIT1", "--db", dbPath, "--json"],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		)).rejects.toThrow();
	});

	it("creates a project -> epic -> initiative chain through the create command", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");

		const projectOut = createCapture();
		const projectErr = createCapture();
		const projectExitCode = await runCli(
			["create", "project", "--title", "Platform", "--db", dbPath],
			{ cwd: root, stderr: projectErr.stream, stdout: projectOut.stream }
		);
		expect(projectExitCode).toBe(0);
		expect(projectErr.read()).toBe("");
		expect(projectOut.read()).toContain("project");

		const { db: afterProjectDb, executor: afterProject } = await ensureDatabase(dbPath, {
			currentWorkingDirectory: root,
			projectIdentity: "default-project"
		});
		const discovery = getProjectDiscovery(afterProject);
		const project = discovery.kind === "available"
			? discovery.projects.find((entry) => entry.project.title === "Platform")?.project
			: undefined;
		afterProjectDb.close();
		expect(project).toBeDefined();

		const epicOut = createCapture();
		const epicErr = createCapture();
		const epicExitCode = await runCli(
			["create", "epic", "--title", "Checkout revamp", "--parent", project!.id, "--db", dbPath],
			{ cwd: root, stderr: epicErr.stream, stdout: epicOut.stream }
		);
		expect(epicExitCode).toBe(0);
		expect(epicErr.read()).toBe("");
		expect(epicOut.read()).toContain("epic");

		const { db: afterEpicDb, executor: afterEpic } = await ensureDatabase(dbPath, {
			currentWorkingDirectory: root,
			projectIdentity: project!.id
		});
		const projectAfterEpic = getDatabaseSnapshot(afterEpic, { projectId: project!.id });
		const epic = projectAfterEpic.kind === "available"
			? projectAfterEpic.snapshot.entities.find((entity) => entity.kind === "epic" && entity.title === "Checkout revamp")
			: undefined;
		afterEpicDb.close();
		expect(epic).toBeDefined();

		const initiativeOut = createCapture();
		const initiativeErr = createCapture();
		const initiativeExitCode = await runCli(
			["create", "initiative", "--title", "Checkout redesign", "--parent", epic!.id, "--db", dbPath],
			{ cwd: root, stderr: initiativeErr.stream, stdout: initiativeOut.stream }
		);
		expect(initiativeExitCode).toBe(0);
		expect(initiativeErr.read()).toBe("");
		expect(initiativeOut.read()).toContain("Checkout redesign");

		const { db: afterInitiativeDb, executor: afterInitiative } = await ensureDatabase(dbPath, {
			currentWorkingDirectory: root,
			projectIdentity: project!.id
		});
		try {
			const projectAfterInitiative = getDatabaseSnapshot(afterInitiative, { projectId: project!.id });
			const initiative = projectAfterInitiative.kind === "available"
				? projectAfterInitiative.snapshot.entities.find((entity) => entity.kind === "initiative" && entity.title === "Checkout redesign")
				: undefined;
			expect(initiative).toBeDefined();

			const epicDetails = getEntityDetails(afterInitiative, epic!.id);
			const projectParent = epicDetails.incoming.find((entry) => entry.relationType === "contains");
			expect(projectParent?.entity.id).toBe(project!.id);

			const initiativeDetails = getEntityDetails(afterInitiative, initiative!.id);
			const epicParent = initiativeDetails.incoming.find((entry) => entry.relationType === "contains");
			expect(epicParent?.entity.id).toBe(epic!.id);
		} finally {
			afterInitiativeDb.close();
		}
	});

	it("creates a version under a project and tags it to an initiative through the create and link commands", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");

		const { db: seedDb, executor: seedExecutor } = await ensureDatabase(dbPath, { currentWorkingDirectory: root });
		const project = createEntity(seedExecutor, { kind: "project", title: "Platform" });
		const initiative = createEntity(seedExecutor, { kind: "initiative", title: "Checkout redesign" });
		seedDb.close();

		const versionOut = createCapture();
		const versionErr = createCapture();
		const versionExitCode = await runCli(
			["create", "version", "--title", "2.0", "--parent", project.id, "--db", dbPath],
			{ cwd: root, stderr: versionErr.stream, stdout: versionOut.stream }
		);
		expect(versionExitCode).toBe(0);
		expect(versionErr.read()).toBe("");
		expect(versionOut.read()).toContain("version");

		const { db: afterVersionDb, executor: afterVersion } = await ensureDatabase(dbPath, {
			currentWorkingDirectory: root,
			projectIdentity: project.id
		});
		const projectSnapshot = getDatabaseSnapshot(afterVersion, { projectId: project.id });
		const version = projectSnapshot.kind === "available"
			? projectSnapshot.snapshot.entities.find((entity) => entity.kind === "version" && entity.title === "2.0")
			: undefined;
		afterVersionDb.close();
		expect(version).toBeDefined();

		const linkOut = createCapture();
		const linkErr = createCapture();
		const linkExitCode = await runCli(
			["link", initiative.id, "taggedWith", version!.id, "--db", dbPath],
			{ cwd: root, stderr: linkErr.stream, stdout: linkOut.stream }
		);
		expect(linkExitCode).toBe(0);
		expect(linkErr.read()).toBe("");
		expect(linkOut.read()).toContain("taggedWith");

		const { db: afterLinkDb, executor: afterLink } = await ensureDatabase(dbPath, {
			currentWorkingDirectory: root,
			projectIdentity: project.id
		});
		try {
			const versionDetails = getEntityDetails(afterLink, version!.id);
			const projectParent = versionDetails.incoming.find((entry) => entry.relationType === "owns");
			expect(projectParent?.entity.id).toBe(project.id);

			const tagger = versionDetails.incoming.find((entry) => entry.relationType === "taggedWith");
			expect(tagger?.entity.id).toBe(initiative.id);
		} finally {
			afterLinkDb.close();
		}
	});

	it("creates initial links and edits an entity title and body through generic commands", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath);
		const initiative = createEntity(executor, { kind: "initiative", title: "Console Viewer" });
		const blocker = createEntity(executor, { kind: "issue", parentId: initiative.id, title: "Blocking issue" });
		const secondBlocker = createEntity(executor, { kind: "issue", parentId: initiative.id, title: "Second blocking issue" });
		db.close();

		const createExitCode = await runCli(
			[
				"create", "issue", "--title", "Initial title", "--parent", initiative.id,
				"--link", "blocks", blocker.id,
				"--link", "blocks", secondBlocker.id,
				"--db", dbPath
			],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		);
		expect(createExitCode).toBe(0);

		const { db: afterCreateDb, executor: afterCreate } = await ensureDatabase(dbPath);
		const created = listEntities(afterCreate, "issue").find((entity) => entity.title === "Initial title");
		expect(getEntityDetails(afterCreate, created!.id).outgoing).toEqual(expect.arrayContaining([
			expect.objectContaining({ entity: expect.objectContaining({ id: blocker.id }), relationType: "blocks" }),
			expect.objectContaining({ entity: expect.objectContaining({ id: secondBlocker.id }), relationType: "blocks" })
		]));
		afterCreateDb.close();

		const editExitCode = await runCli(
			["edit", created!.id, "--title", "Final title", "--body-file", writeBodyFile(root, "Final body"), "--db", dbPath],
			{ cwd: root, stderr: createCapture().stream, stdout: createCapture().stream }
		);
		expect(editExitCode).toBe(0);

		const { db: afterEditDb, executor: afterEdit } = await ensureDatabase(dbPath);
		try {
			expect(getEntityDetails(afterEdit, created!.id).entity).toEqual(expect.objectContaining({ body: "Final body", title: "Final title" }));
			expect(materializeEntityRevision(afterEdit, { entityId: created!.id, revision: 1 })).toMatchObject({
				body: "",
				title: "Initial title"
			});
		} finally {
			afterEditDb.close();
		}

		const error = createCapture();
		await expect(runCli(["edit", created!.id, "--db", dbPath], { cwd: root, stderr: error.stream, stdout: createCapture().stream })).rejects.toThrow(
			"--title, --body-file, --category, --priority, or --type is required for edit."
		);
	});

	it("materializes an earlier entity revision through the generic history command", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		const created = await store.createEntity({ kind: "issue", title: "Initial title", body: "Initial body" });
		await store.updateEntity({
			entityId: created.id,
			title: "Updated title",
			body: "Updated body",
			expectedRevision: created.revision,
			expectedContentHash: created.contentHash
		});
		await store.close();

		const stdout = createCapture();
		const exitCode = await runCli(
			["history", created.id, "--revision", "1", "--db", dbPath],
			{ cwd: root, stderr: createCapture().stream, stdout: stdout.stream }
		);

		expect(exitCode).toBe(0);
		expect(stdout.read()).toContain(`${created.id} revision 1/2`);
		expect(stdout.read()).toContain("Initial title");
		expect(stdout.read()).toContain("Initial body");
	});

	it("materializes context and forgotten term revisions through the generic history command", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		const context1 = await store.upsertContext({ title: "Initial context", summary: "Initial summary." });
		await store.upsertContext({ title: "Current context", summary: "Current summary.", expectedRevision: context1.context.revision, expectedContentHash: context1.context.contentHash });
		const term1 = await store.defineContextTerm({ term: "Order", definition: "Initial definition." });
		const term2 = await store.defineContextTerm({ term: "Order", definition: "Current definition.", avoid: ["purchase"], expectedRevision: term1.term.revision, expectedContentHash: term1.term.contentHash });
		await store.forgetContextTerm({ term: "Order", expectedRevision: term2.term.revision, expectedContentHash: term2.term.contentHash });
		await store.close();

		const contextStdout = createCapture();
		expect(await runCli(["history", "--context", "default", "--revision", "1", "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: contextStdout.stream })).toBe(0);
		expect(contextStdout.read()).toContain("default context revision 1/2 Initial context");

		const termStdout = createCapture();
		expect(await runCli(["history", "--context", "default", "--term", "Order", "--revision", "1", "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: termStdout.stream })).toBe(0);
		expect(termStdout.read()).toContain("default term Order revision 1/3");
		expect(termStdout.read()).toContain("Initial definition.");
	});

	it("restores active and deleted entities as new heads through the generic restore command", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		const parent = await store.createEntity({ kind: "initiative", title: "Parent" });
		const created = await store.createEntity({ kind: "issue", title: "Initial", body: "Initial body", parentId: parent.id });
		await store.updateEntity({ entityId: created.id, title: "Edited", body: "Edited body", expectedRevision: created.revision, expectedContentHash: created.contentHash });
		await store.close();

		const firstStdout = createCapture();
		expect(await runCli(["restore", created.id, "--revision", "1", "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: firstStdout.stream })).toBe(0);
		expect(firstStdout.read()).toContain(`Restored ${created.id} revision 1 as revision 3`);

		const reopened = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		const restoredHead = (await reopened.store.getEntityDetails(created.id)).entity;
		expect(restoredHead).toEqual(expect.objectContaining({ title: "Initial", body: "Initial body", revision: 3 }));
		await reopened.store.deleteEntity({ entityId: created.id });
		await reopened.store.close();

		const secondStdout = createCapture();
		expect(await runCli(["restore", created.id, "--revision", "3", "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: secondStdout.stream })).toBe(0);
		expect(secondStdout.read()).toContain(`Restored ${created.id} revision 3 as revision 5`);

		const finalStore = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		try {
			expect((await finalStore.store.getEntityDetails(created.id)).entity).toEqual(expect.objectContaining({ title: "Initial", revision: 5 }));
			expect(await finalStore.store.materializeEntityRevision({ entityId: created.id, revision: 3 })).toEqual(expect.objectContaining({ restoredFromRevision: 1 }));
		} finally {
			await finalStore.store.close();
		}
	});

	it("restores context and forgotten term revisions through the generic restore command", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		const context1 = await store.upsertContext({ title: "Initial context", summary: "Initial summary." });
		await store.upsertContext({ title: "Current context", summary: "Current summary.", expectedRevision: context1.context.revision, expectedContentHash: context1.context.contentHash });
		const term1 = await store.defineContextTerm({ term: "Order", definition: "Initial definition." });
		const term2 = await store.defineContextTerm({ term: "Order", definition: "Current definition.", expectedRevision: term1.term.revision, expectedContentHash: term1.term.contentHash });
		await store.forgetContextTerm({ term: "Order", expectedRevision: term2.term.revision, expectedContentHash: term2.term.contentHash });
		await store.close();

		const contextStdout = createCapture();
		expect(await runCli(["restore", "--context", "default", "--revision", "1", "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: contextStdout.stream })).toBe(0);
		expect(contextStdout.read()).toContain("Restored default context revision 1 as revision 3");

		const termStdout = createCapture();
		expect(await runCli(["restore", "--context", "default", "--term", "Order", "--revision", "1", "--db", dbPath], { cwd: root, stderr: createCapture().stream, stdout: termStdout.stream })).toBe(0);
		expect(termStdout.read()).toContain("Restored default term Order revision 1 as revision 4");

		const reopened = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		try {
			expect((await reopened.store.getContextDetails()).context).toEqual(expect.objectContaining({ title: "Initial context", revision: 3 }));
			expect((await reopened.store.getContextDetails()).terms).toEqual([expect.objectContaining({ term: "Order", definition: "Initial definition.", revision: 4 })]);
			expect(await reopened.store.materializeContextRevision({ revision: 3 })).toEqual(expect.objectContaining({ restoredFromRevision: 1 }));
			expect(await reopened.store.materializeContextTermRevision({ term: "Order", revision: 4 })).toEqual(expect.objectContaining({ restoredFromRevision: 1, tombstone: false }));
		} finally {
			await reopened.store.close();
		}
	});

	it("resurrects a forgotten context term through the context command", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const io = { cwd: root, stderr: createCapture().stream, stdout: createCapture().stream };

		expect(await runCli(["context", "define", "Order", "--body-file", writeBodyFile(root, "Initial."), "--db", dbPath], io)).toBe(0);
		expect(await runCli(["context", "forget", "Order", "--db", dbPath], io)).toBe(0);
		expect(await runCli(["context", "forget", "Order", "--db", dbPath], io)).toBe(0);
		expect(await runCli(["context", "define", "Order", "--body-file", writeBodyFile(root, "Restored."), "--db", dbPath], io)).toBe(0);

		const { store } = await openSqliteStore(dbPath, { currentWorkingDirectory: root });
		try {
			expect((await store.getContextDetails()).terms).toEqual([
				expect.objectContaining({ term: "Order", definition: "Restored.", revision: 3 })
			]);
		} finally {
			await store.close();
		}
	});

	it("creates sub-issues through the existing create command and shows them through the initiative read", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const stdout = createCapture();
		const stderr = createCapture();
		const { db, executor } = await ensureDatabase(dbPath);
		const initiative = createEntity(executor, { kind: "initiative", title: "Console Viewer" });
		const parentIssue = createEntity(executor, { kind: "issue", parentId: initiative.id, title: "Parent issue" });
		db.close();

		const createExitCode = await runCli(
			["create", "issue", "--title", "Sub-issue", "--parent", parentIssue.id, "--db", dbPath, "--json"],
			{ cwd: root, stderr: stderr.stream, stdout: stdout.stream }
		);

		expect(createExitCode).toBe(0);
		expect(stderr.read()).toBe("");
		const subIssue = JSON.parse(stdout.read()) as { id: string; reference: string };
		expect(subIssue).toMatchObject({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), reference: expect.stringMatching(/^ISS_[0-7][0-9A-HJKMNP-TV-Z]{25}$/) });

		const showStdout = createCapture();
		const showStderr = createCapture();
		const showExitCode = await runCli(["show", initiative.id, "--db", dbPath], {
			cwd: root,
			stderr: showStderr.stream,
			stdout: showStdout.stream
		});

		expect(showExitCode).toBe(0);
		expect(showStderr.read()).toBe("");
		expect(showStdout.read()).toContain("Sub-issues:");
		expect(showStdout.read()).toContain(`${parentIssue.reference} -> ${subIssue.reference}`);
	});

	it("exports one initiative to a grouped directory by default", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath);
		const initiative = createEntity(executor, { kind: "initiative", title: "Console Viewer", body: "Initiative body" });
		const issue = createEntity(executor, { kind: "issue", parentId: initiative.id, title: "Render detail view", body: "Issue body" });
		db.close();

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(["export", initiative.id, "--db", dbPath], {
			cwd: root,
			stderr: stderr.stream,
			stdout: stdout.stream
		});

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain(`Exported initiative to ${path.join(root, "agent-issues-export", initiative.id)}`);
		expect(existsSync(path.join(root, "agent-issues-export", initiative.id, "initiative.md"))).toBe(true);
		expect(existsSync(path.join(root, "agent-issues-export", initiative.id, "issues", `${issue.id}.md`))).toBe(true);
	});

	it("resolves comment provenance in an initiative directory export", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath);
		const initiative = createEntity(executor, { kind: "initiative", title: "Conversation export" });
		const issue = createEntity(executor, { kind: "issue", parentId: initiative.id, title: "Export comments" });
		db.close();
		const { store } = await openSqliteStore(dbPath);
		const commentStore = store.withAuthenticatedIdentity({
			userId: "commenter",
			tenantId: store.tenantId,
			displayName: "Commenter Name"
		});
		await commentStore.createIssueComment({ issueId: issue.id, body: "Conversation content." });
		await store.close();
		const previousNoDaemon = process.env.AGENT_ISSUES_NO_DAEMON;
		process.env.AGENT_ISSUES_NO_DAEMON = "1";

		try {
			const exitCode = await runCli(["export", initiative.id, "--db", dbPath], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: createCapture().stream
			});

			expect(exitCode).toBe(0);
			const issueExport = readFileSync(path.join(root, "agent-issues-export", initiative.id, "issues", `${issue.id}.md`), "utf8");
			expect(issueExport).toContain("Created by: Commenter Name (commenter)");
			expect(issueExport).toContain("Updated by: Commenter Name (commenter)");
		} finally {
			if (previousNoDaemon === undefined) {
				delete process.env.AGENT_ISSUES_NO_DAEMON;
			} else {
				process.env.AGENT_ISSUES_NO_DAEMON = previousNoDaemon;
			}
		}
	});

	it("exports the whole project to a grouped directory by default", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath);
		const initiative = createEntity(executor, { kind: "initiative", title: "Console Viewer" });
		createEntity(executor, { kind: "adr", title: "Use SVG graphs" });
		db.close();

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(["export", "project", "--db", dbPath], {
			cwd: root,
			stderr: stderr.stream,
			stdout: stdout.stream
		});

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain(`Exported project to ${path.join(root, "agent-issues-export", "project")}`);
		expect(existsSync(path.join(root, "agent-issues-export", "project", "project.md"))).toBe(true);
		expect(existsSync(path.join(root, "agent-issues-export", "project", "initiatives", initiative.id, "initiative.md"))).toBe(true);
	});

	it("emits single-file markdown when requested", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath);
		const initiative = createEntity(executor, { kind: "initiative", title: "Console Viewer", body: "Initiative body" });
		db.close();

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(["export", initiative.id, "--single-file", "--db", dbPath], {
			cwd: root,
			stderr: stderr.stream,
			stdout: stdout.stream
		});

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain("type: \"initiative-export\"");
		expect(stdout.read()).toContain(`# ${initiative.id} Console Viewer`);
	});

	it("includes full issue conversations in a single-file initiative export", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath);
		const initiative = createEntity(executor, { kind: "initiative", title: "Conversation export" });
		const issue = createEntity(executor, { kind: "issue", parentId: initiative.id, title: "Export comments" });
		db.close();
		const { store } = await openSqliteStore(dbPath);
		const comment = await store.createIssueComment({ issueId: issue.id, body: "Conversation content." });
		await store.close();
		const previousNoDaemon = process.env.AGENT_ISSUES_NO_DAEMON;
		process.env.AGENT_ISSUES_NO_DAEMON = "1";

		try {
			const stdout = createCapture();
			const exitCode = await runCli(["export", initiative.id, "--single-file", "--db", dbPath], {
				cwd: root,
				stderr: createCapture().stream,
				stdout: stdout.stream
			});

			expect(exitCode).toBe(0);
			expect(stdout.read()).toContain(`##### ${comment.reference}`);
			expect(stdout.read()).toContain("Conversation content.");
		} finally {
			if (previousNoDaemon === undefined) {
				delete process.env.AGENT_ISSUES_NO_DAEMON;
			} else {
				process.env.AGENT_ISSUES_NO_DAEMON = previousNoDaemon;
			}
		}
	});

	it("writes single-file markdown to an explicit file path", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const outputPath = path.join(root, "exports", "initiative.md");
		const { db, executor } = await ensureDatabase(dbPath);
		const initiative = createEntity(executor, { kind: "initiative", title: "Console Viewer" });
		db.close();

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(
			["export", initiative.id, "--single-file", "--output", outputPath, "--db", dbPath],
			{
				cwd: root,
				stderr: stderr.stream,
				stdout: stdout.stream
			}
		);

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain(`Exported initiative ${initiative.id} to ${outputPath}`);
		expect(readFileSync(outputPath, "utf8")).toContain("type: \"initiative-export\"");
	});

	it("stops a running live site through the cli", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const stdout = createCapture();
		const stderr = createCapture();
		const port = await getAvailablePort();
		const { db } = await ensureDatabase(dbPath, { tenant: "test-tenant" });
		db.close();

		const handle = await startLiveSite({ currentWorkingDirectory: root, dbPath, port, tenant: "test-tenant" });
		liveSiteClosers.add(() => {
			if (handle.server.listening) {
				handle.close();
			}
		});

		await new Promise<void>((resolve) => {
			handle.server.once("listening", () => resolve());
		});

		const closePromise = new Promise<void>((resolve) => {
			handle.server.once("close", () => resolve());
		});

		const exitCode = await runCli(["site", "--stop", "--port", String(port)], {
			cwd: root,
			stderr: stderr.stream,
			stdout: stdout.stream
		});

		await closePromise;
		liveSiteClosers.delete(handle.close);

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain(`Stopped live site at http://127.0.0.1:${port}`);
	});

	it("serves an explicitly selected project snapshot through the seam", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const port = await getAvailablePort();
		const { db, executor } = await ensureDatabase(dbPath, { tenant: "test-tenant" });
		const project = createEntity(executor, { kind: "project", title: "Console Viewer" });
		const epic = createEntity(executor, { kind: "epic", title: "Console Epic", parentId: project.id });
		const initiative = createEntity(executor, { kind: "initiative", parentId: epic.id, title: "Console Viewer" });
		db.close();

		const handle = await startLiveSite({ currentWorkingDirectory: root, dbPath, port, tenant: "test-tenant" });
		liveSiteClosers.add(() => {
			if (handle.server.listening) {
				handle.close();
			}
		});

		await new Promise<void>((resolve) => {
			handle.server.once("listening", () => resolve());
		});

		try {
			const configResponse = await fetch(`http://127.0.0.1:${port}/site-config.json`);
			const config = await configResponse.json();
			expect(config.currentTenant).toBe("test-tenant");
			expect(config.dbPath).toBe(dbPath);
			expect(config.availableTenants.map((tenant: { id: string }) => tenant.id)).toContain("test-tenant");

			const snapshotResponse = await fetch(`http://127.0.0.1:${port}/api/snapshot?tenant=test-tenant&project=${project.id}`);
			const snapshot = await snapshotResponse.json();
			expect(snapshot.kind).toBe("available");
			expect(snapshot.snapshot.entities.map((entity: { id: string }) => entity.id)).toContain(initiative.id);

			const unavailableResponse = await fetch(`http://127.0.0.1:${port}/api/snapshot?tenant=test-tenant&project=PROJ404`);
			expect(await unavailableResponse.json()).toEqual({ kind: "unavailable" });
		} finally {
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", () => resolve());
			});
			handle.close();
			await closePromise;
			liveSiteClosers.delete(handle.close);
		}
	});

	it("returns typed unavailable project discovery for an unknown tenant without bootstrapping it", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const port = await getAvailablePort();
		const { db } = await ensureDatabase(dbPath, { tenant: "known-tenant" });
		db.close();

		const handle = await startLiveSite({ currentWorkingDirectory: root, dbPath, port, tenant: "known-tenant" });
		liveSiteClosers.add(() => {
			if (handle.server.listening) {
				handle.close();
			}
		});
		await new Promise<void>((resolve) => {
			handle.server.once("listening", resolve);
		});

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/projects?tenant=missing-tenant`);
			expect(await response.json()).toEqual({ kind: "unavailable" });

			const { db: verificationDb, executor: verificationExecutor } = await ensureDatabase(dbPath, { tenant: "known-tenant" });
			try {
				expect(listEntities(verificationExecutor, "project").map((entity) => entity.reference)).toEqual([
					expect.stringMatching(/^PROJ_[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
				]);
				expect(listTenants(verificationDb).map((tenant) => tenant.id)).toEqual(["known-tenant"]);
			} finally {
				verificationDb.close();
			}
		} finally {
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", resolve);
			});
			handle.close();
			await closePromise;
			liveSiteClosers.delete(handle.close);
		}
	});

	it("broadcasts a snapshot-changed event through the seam after a local write (ISS191)", async () => {
		const root = createTempDir();
		const dbPath = path.join(root, "agent-issues.db");
		const port = await getAvailablePort();
		const { db } = await ensureDatabase(dbPath, { tenant: "test-tenant" });
		db.close();

		const handle = await startLiveSite({ currentWorkingDirectory: root, dbPath, port, tenant: "test-tenant", pollIntervalMs: 20 });
		liveSiteClosers.add(() => {
			if (handle.server.listening) {
				handle.close();
			}
		});

		await new Promise<void>((resolve) => {
			handle.server.once("listening", () => resolve());
		});

		const listener = waitForSnapshotChangedEvent(`http://127.0.0.1:${port}/events`);
		await listener.ready;

		try {
			const { db: writeDb, executor: writeExecutor } = await ensureDatabase(dbPath, { tenant: "test-tenant" });
			createEntity(writeExecutor, { kind: "initiative", title: "Live-refresh through the seam" });
			writeDb.close();

			const event = await Promise.race([
				listener.event,
				new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for snapshot-changed")), 5000))
			]);

			expect(event).toMatchObject({ type: "snapshot-changed" });
		} finally {
			listener.stop();
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", () => resolve());
			});
			handle.close();
			await closePromise;
			liveSiteClosers.delete(handle.close);
		}
	});

	it("reports when no live site is running on the selected port", async () => {
		const stdout = createCapture();
		const stderr = createCapture();
		const port = await getAvailablePort();

		const exitCode = await runCli(["site", "--stop", "--port", String(port)], {
			stderr: stderr.stream,
			stdout: stdout.stream
		});

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain(`No live site was running at http://127.0.0.1:${port}`);
	});

	it("reports when another server is listening on the selected port", async () => {
		const stdout = createCapture();
		const stderr = createCapture();
		const port = await getAvailablePort();
		const server = createServer();

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => resolve());
		});

		liveSiteClosers.add(() => {
			if (server.listening) {
				server.close();
			}
		});

		const exitCode = await runCli(["site", "--stop", "--port", String(port)], {
			stderr: stderr.stream,
			stdout: stdout.stream
		});

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toContain(`A server is listening at http://127.0.0.1:${port}, but it does not expose the agent-issues stop endpoint.`);
	});
});