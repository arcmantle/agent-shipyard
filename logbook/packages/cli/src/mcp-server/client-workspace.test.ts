import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fileRootPath, resolveClientWorkspaceRoot, resolveMcpWorkspaceScope, selectWorkspaceRoot } from "./client-workspace.js";

describe("client workspace root", () => {
	it("selects the first file root as the chat folder", () => {
		const chatFolder = path.join(tmpdir(), "chat-folder");

		expect(
			selectWorkspaceRoot([
				{ uri: "https://example.test/not-a-folder" },
				{ uri: pathToFileURL(chatFolder).href }
			])
		).toBe(chatFolder);
	});

	it("rejects a non-file URI", () => {
		expect(fileRootPath("https://example.test/repo")).toBeUndefined();
	});

	it("uses the fallback when the client does not advertise roots", async () => {
		const workspaceRoot = await resolveClientWorkspaceRoot(
			async () => {
				throw new Error("listRoots must not run when the client has no roots capability");
			},
			{},
			"/fallback"
		);

		expect(workspaceRoot).toBe("/fallback");
	});

	it("asks for roots when client capabilities are unknown", async () => {
		const chatFolder = path.join(tmpdir(), "chat-folder");
		const workspaceRoot = await resolveClientWorkspaceRoot(
			async () => ({
				roots: [{ uri: pathToFileURL(chatFolder).href }]
			}),
			undefined,
			"/fallback"
		);

		expect(workspaceRoot).toBe(chatFolder);
	});

	it("uses the first file root when the client advertises roots", async () => {
		const chatFolder = path.join(tmpdir(), "chat-folder");
		const workspaceRoot = await resolveClientWorkspaceRoot(
			async () => ({
				roots: [{ uri: pathToFileURL(chatFolder).href }]
			}),
			{ roots: { listChanged: true } },
			"/fallback"
		);

		expect(workspaceRoot).toBe(chatFolder);
	});

	it("uses the fallback when listRoots fails", async () => {
		const workspaceRoot = await resolveClientWorkspaceRoot(
			async () => {
				throw new Error("roots unavailable");
			},
			{ roots: {} },
			"/fallback"
		);

		expect(workspaceRoot).toBe("/fallback");
	});

	it("resolves identity from the chat folder unless an explicit identity is set", async () => {
		const chatFolder = path.join(tmpdir(), "chat-folder");
		const fromFolder = await resolveMcpWorkspaceScope({
			listRoots: async () => ({ roots: [{ uri: pathToFileURL(chatFolder).href }] }),
			capabilities: { roots: {} },
			fallbackWorkspaceRoot: "/fallback",
			resolveIdentity: (workspaceRoot) => `${workspaceRoot}-identity`
		});
		const explicit = await resolveMcpWorkspaceScope({
			listRoots: async () => ({ roots: [{ uri: pathToFileURL(chatFolder).href }] }),
			capabilities: { roots: {} },
			projectIdentity: "shared-product",
			resolveIdentity: (workspaceRoot) => `${workspaceRoot}-identity`
		});

		expect(fromFolder).toEqual({ projectIdentity: `${chatFolder}-identity`, workspaceRoot: chatFolder });
		expect(explicit).toEqual({ projectIdentity: "shared-product", workspaceRoot: chatFolder });
	});
});
