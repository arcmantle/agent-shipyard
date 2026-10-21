import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteStore } from "@agent-issues/api-local";
import type { InstructionBundle } from "@agent-issues/core";

let targetDir: string | null = null;

afterEach(() => {
	if (targetDir) {
		rmSync(targetDir, { force: true, recursive: true });
		targetDir = null;
	}
});

describe("portable plugin package", () => {
	it("loads database instructions for every discovered skill and host agent", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const pluginDir = path.join(targetDir, "plugin");
		buildPlugin(pluginDir);
		const skillNames = readdirSync("skills", { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(path.join("skills", entry.name, "SKILL.md")))
			.map((entry) => entry.name);
		const loaders = [
			...skillNames.map((name) => ({ source: `skills/${name}/SKILL.md`, output: `skills/${name}/SKILL.md`, key: `skill/${name}` })),
			{ source: ".github/agents/agent-issues.claude.md", output: "agents/agent-issues.md", key: "agent/agent-issues-claude" },
			{ source: ".github/agents/agent-issues.agent.md", output: "agents/copilot/agent-issues.agent.md", key: "agent/agent-issues" },
			{ source: ".github/agents/agent-issues.agent.md", output: "com.github.copilot/agents/agent-issues.agent.md", key: "agent/agent-issues" }
		];
		for (const { source, output, key } of loaders) {
			const sourceContent = readFileSync(source, "utf8");
			const content = readFileSync(path.join(pluginDir, output), "utf8");
			const frontmatter = sourceContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0];
			expect(frontmatter).toBeDefined();
			expect(content.startsWith(frontmatter!)).toBe(true);
			const [kind, name] = key.split("/");
			expect(content).toContain(`This file is the loader for the \`${name}\` ${kind}.`);
			expect(content).toContain(`Before you use this ${kind}, call the agent-issues MCP tool \`instruction_retrieve\` with these arguments:`);
			const argumentsBlock = content.match(/```json\n([\s\S]*?)\n```/)?.[1];
			expect(argumentsBlock).toBeDefined();
			expect(JSON.parse(argumentsBlock!)).toEqual({ key });
			expect(content).toContain("The first text block contains JSON metadata. The second contains one Markdown part.");
			expect(content).toContain("the same `key` and `documentHash`, with `nextOffset` as `offset`");
			expect(content).toContain("Copy the returned offset; do not calculate it.");
			expect(content).toContain("Continue until `nextOffset` is null.");
			expect(content).toContain(`Read all Markdown parts in order before you use this ${kind}.`);
			expect(content).toContain("the same `documentHash` and `version`");
			expect(content).toContain("discard all parts and restart with `key` only");
			expect(content).toContain("Do not use shell commands or local files to retrieve these instructions.");
			expect(content).toContain(`Follow the complete returned document as this ${kind}'s instructions.`);
			expect(content).toContain("If the tool is unavailable or another retrieval failure occurs, stop");
			expect(content).toContain("Do not use cached, bundled, or older-default instructions");
			expect(content).not.toContain("## Required Workflow");
			expect(content).not.toContain("[language standard]");
			expect(content.length).toBeLessThan(2_000);
		}
		expect(readdirSync(path.join(pluginDir, "skills")).sort()).toEqual(skillNames.sort());
		for (const name of skillNames) {
			expect(readdirSync(path.join(pluginDir, "skills", name))).toEqual(["SKILL.md"]);
		}
	});

	it("supplies complete release-matched database instructions for every loader key", async () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const pluginDir = path.join(targetDir, "plugin");
		buildPlugin(pluginDir);
		const bundle = JSON.parse(readFileSync(path.join(pluginDir, "instruction-defaults.json"), "utf8")) as InstructionBundle;
		const version = JSON.parse(readFileSync("package.json", "utf8")).version as string;
		const { store } = await openSqliteStore(path.join(targetDir, "instructions.db"));
		try {
			const previousBody = "Previous release instructions.";
			await store.importInstructionBundle({ version: "0.2.0", items: [{ key: "skill/prepare", kind: "skill", body: previousBody }] });
			await store.importInstructionBundle(bundle);
			expect(await store.retrieveInstruction({ version: "0.2.0", key: "skill/prepare" })).toMatchObject({ body: previousBody });
			for (const item of bundle.items.filter((item) => item.kind !== "fragment")) {
				const retrieved = await store.retrieveInstruction({ version, key: item.key });
				expect(retrieved.version).toBe(version);
				expect(retrieved.body).toContain("# Language standard");
				expect(retrieved.fragments).toEqual(expect.arrayContaining([
					expect.objectContaining({ key: "fragment/agent-issues-language" })
				]));
				if (item.kind === "skill") {
					expect(retrieved.body).toContain("# Shared Skill Operating Contract");
					expect(retrieved.body).toContain("# Record Body Recipe Catalog");
					expect(retrieved.body).toContain('resource_show({ request: { resource: "entity"');
					expect(retrieved.body).toContain('resource_body({ request: { resource: "entity"');
					expect(retrieved.body).toContain('resource_history({ request: { resource: "planEntry", action: "list"');
					expect(retrieved.body).toContain('resource_history({ request: { resource: "comment", action: "list"');
					expect(retrieved.body).toContain("Selected revisions return metadata and `reads.body` references");
					expect(retrieved.body).toContain("Runtime loaders must not use `resource_body`.");
				}
				expect(retrieved.body).not.toContain("<!-- include:");
			}
			for (const item of bundle.items) {
				const references = [...item.body.matchAll(/^- `[^`]+`: `((?:fragment|skill|agent)\/[^`]+)`\.$/gm)];
				for (const [, key] of references) {
					await expect(store.retrieveInstruction({ version, key })).resolves.toMatchObject({ key, version });
				}
			}
			const domainModeling = await store.retrieveInstruction({ version, key: "skill/domain-modeling" });
			expect(domainModeling.body).toContain('- `./CONTEXT-FORMAT.md`: `fragment/domain-modeling/context-format`.');
			expect(domainModeling.body).toContain('- `./ADR-FORMAT.md`: `fragment/domain-modeling/adr-format`.');
			expect(domainModeling.body).toContain('- `./context-summary.md`: `fragment/recipes/context-summary`.');
			const prototype = await store.retrieveInstruction({ version, key: "skill/prototype" });
			expect(prototype.body).toContain('- `LOGIC.md`: `fragment/prototype/logic`.');
			expect(prototype.body).toContain('- `UI.md`: `fragment/prototype/ui`.');
			const tdd = await store.retrieveInstruction({ version, key: "skill/tdd" });
			expect(tdd.body).toContain('- `tests.md`: `fragment/tdd/tests`.');
			const nextWork = await store.retrieveInstruction({ version, key: "skill/next-work" });
			expect(nextWork.body).toContain("returns up to five next-in-line candidates");
			expect(nextWork.body).toContain("It does not choose the recommendation.");
			expect(nextWork.body).toContain("Select from the returned list without reading every available issue.");
			expect(nextWork.body).toContain("`entity_next_work({ scopeId, limit? })`");
			expect(nextWork.body).not.toContain("returns the complete work order");
			expect(nextWork.body).not.toContain("Join all sections before you compare candidates");
			await expect(store.retrieveInstruction({ version: "missing-release", key: "skill/prepare" })).rejects.toThrow();
		} finally {
			await store.close();
		}
	});

	it("uses immutable content-based development bundles without losing personal edits", async () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-development-bundle-"));
		const sourceDir = path.join(targetDir, "source");
		const pluginDir = path.join(targetDir, "plugin");
		copyPluginSource(sourceDir);
		const releaseVersion = JSON.parse(readFileSync(path.join(sourceDir, "package.json"), "utf8")).version as string;
		const readBundle = () => JSON.parse(readFileSync(path.join(pluginDir, "instruction-defaults.json"), "utf8")) as InstructionBundle;
		buildPlugin(pluginDir, sourceDir, true);
		const first = readBundle();
		expect(first.version).toMatch(new RegExp(`^${releaseVersion.replaceAll(".", "\\.")}-dev\\.[a-f0-9]{64}$`));
		buildPlugin(pluginDir, sourceDir, true);
		expect(readBundle()).toEqual(first);
		const { store } = await openSqliteStore(path.join(targetDir, "instructions.db"));
		try {
			await store.importInstructionBundle(first);
			const saved = await store.saveInstructionSource({ version: first.version, key: "skill/prepare", body: "Personal instructions", expectedRevision: 1 });
			const sourcePath = path.join(sourceDir, "skills", "prepare", "SKILL.md");
			writeFileSync(sourcePath, `${readFileSync(sourcePath, "utf8")}\nChanged development instructions.\n`);
			buildPlugin(pluginDir, sourceDir, true);
			const changed = readBundle();
			expect(changed.version).not.toBe(first.version);
			await store.importInstructionBundle(changed);
			expect(await store.readInstructionSource({ version: changed.version, key: "skill/prepare" })).toMatchObject({ body: "Personal instructions", source: saved.source });
			await store.importInstructionBundle(first);
			buildPlugin(pluginDir, sourceDir);
			expect(readBundle().version).toBe(releaseVersion);
		} finally {
			await store.close();
		}
	});

	it("preserves reference links and expands explicit includes at their authored positions", async () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const sourceDir = path.join(targetDir, "source");
		copyPluginSource(sourceDir);
		const sourcePath = path.join(sourceDir, "skills", "prepare", "SKILL.md");
		writeFileSync(path.join(sourceDir, "skills", "prepare", "reference-only.md"), "Reference-only content.");
		writeFileSync(path.join(sourceDir, "skills", "prepare", "at-position.md"), "Explicitly included content.");
		const reference = "[reference document](./reference-only.md)";
		writeFileSync(sourcePath, `${readFileSync(sourcePath, "utf8")}\nAn example: \`${reference}\`; follow ${reference}.\n\n\`\`\`md\n${reference}\n\`\`\`\n\nBefore include.\n<!-- include:fragment/prepare/at-position -->\nAfter include.\n`);
		const pluginDir = path.join(targetDir, "plugin");
		buildPlugin(pluginDir, sourceDir);
		const bundle = JSON.parse(readFileSync(path.join(pluginDir, "instruction-defaults.json"), "utf8")) as InstructionBundle;
		const { store } = await openSqliteStore(path.join(targetDir, "instructions.db"));
		try {
			await store.importInstructionBundle(bundle);
			const retrieved = await store.retrieveInstruction({ version: bundle.version, key: "skill/prepare" });
			expect(retrieved.body).toContain(`An example: \`${reference}\`; follow ${reference}.`);
			expect(retrieved.body).toContain(`\`\`\`md\n${reference}\n\`\`\``);
			expect(retrieved.body).toContain('- `./reference-only.md`: `fragment/prepare/reference-only`.');
			expect(retrieved.body).not.toContain("Reference-only content.");
			expect(retrieved.body).toContain("Before include.\nExplicitly included content.\nAfter include.");
		} finally {
			await store.close();
		}
	});

	it("rejects missing instruction links but ignores examples and external documents", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const sourceDir = path.join(targetDir, "source");
		const pluginDir = path.join(targetDir, "plugin");
		copyPluginSource(sourceDir);
		const sourcePath = path.join(sourceDir, "skills", "prepare", "SKILL.md");
		const body = readFileSync(sourcePath, "utf8");
		const missing = "[missing document](./missing.md)";
		writeFileSync(sourcePath, `${body}\n\`${missing}\`\n\n\`\`\`md\n${missing}\n\`\`\`\n\n[external document](https://example.com/missing.md)\n`);
		expect(() => buildPlugin(pluginDir, sourceDir)).not.toThrow();
		const bundlePath = path.join(pluginDir, "instruction-defaults.json");
		const previousBundle = readFileSync(bundlePath, "utf8");
		writeFileSync(sourcePath, `${body}\n${missing}\n`);
		const build = spawnSync(process.execPath, [
			"scripts/build-plugin.mjs", "--source-dir", sourceDir, "--target-dir", pluginDir
		], { encoding: "utf8" });
		expect(build.status).toBe(1);
		expect(build.stderr).toContain("Instruction reference not found: skill/prepare: ./missing.md");
		expect(readFileSync(bundlePath, "utf8")).toBe(previousBundle);
	});

	it("packages every canonical skill with portable metadata and a global MCP server", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const pluginDir = path.join(targetDir, "plugin");
		mkdirSync(pluginDir);

		buildPlugin(pluginDir);

		expect(readFileSync(path.join(pluginDir, "README.md"), "utf8")).toContain(
			"# Agent Issues Plugin"
		);
		expect(readFileSync(path.join(pluginDir, "README.md"), "utf8")).toContain(
			"npm install --global agent-issues agent-issues-mcp"
		);

		const manifest = JSON.parse(readFileSync(path.join(pluginDir, "plugin.json"), "utf8")) as {
			$schema?: unknown;
			name?: unknown;
			agents?: unknown;
		};
		expect(manifest).toMatchObject({
			$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			name: "agent-issues"
		});
		expect(manifest.agents).toBeUndefined();

		const mcpConfiguration = JSON.parse(readFileSync(path.join(pluginDir, "mcp.json"), "utf8")) as {
			$schema?: unknown;
			mcpServers?: Record<string, { type?: unknown; command?: unknown; args?: unknown }>;
		};

		expect(mcpConfiguration.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
		expect(mcpConfiguration.mcpServers?.["agent-issues"]).toEqual({
			type: "stdio",
			command: "agent-issues-mcp",
			args: []
		});
	});

	it("adds the Claude Code manifest, agent, and MCP adapter", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const pluginDir = path.join(targetDir, "plugin");

		buildPlugin(pluginDir);

		const manifest = JSON.parse(
			readFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), "utf8")
		) as { name?: unknown; agents?: unknown };
		expect(manifest.name).toBe("agent-issues");
		expect(manifest.agents).toBeUndefined();
		expect(readFileSync(path.join(pluginDir, ".mcp.json"), "utf8")).toBe(
			readFileSync(path.join(pluginDir, "mcp.json"), "utf8")
		);
	});

	it("adds a Claude marketplace that installs the package root", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const pluginDir = path.join(targetDir, "plugin");

		buildPlugin(pluginDir);

		const marketplace = JSON.parse(
			readFileSync(path.join(pluginDir, ".claude-plugin", "marketplace.json"), "utf8")
		) as {
			name?: unknown;
			plugins?: unknown;
		};
		expect(marketplace).toMatchObject({
			name: "agent-issues",
			plugins: [{ name: "agent-issues", source: "./" }]
		});
	});

	it("adds the Copilot agent and marketplace adapter", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const pluginDir = path.join(targetDir, "plugin");

		buildPlugin(pluginDir);

		const copilotManifest = JSON.parse(
			readFileSync(path.join(pluginDir, ".plugin", "plugin.json"), "utf8")
		) as { name?: unknown; agents?: unknown };
		expect(copilotManifest).toMatchObject({
			name: "agent-issues",
			agents: "agents/copilot/"
		});
		const { agents, ...copilotPortableFields } = copilotManifest;
		const portableManifest = JSON.parse(
			readFileSync(path.join(pluginDir, "plugin.json"), "utf8")
		) as Record<string, unknown>;
		expect(agents).toBe("agents/copilot/");
		expect(copilotPortableFields).toEqual(portableManifest);
		const agentPath = path.join(pluginDir, "agents", "copilot", "agent-issues.agent.md");
		const agentContent = readFileSync(agentPath, "utf8");
		const portableCopilotAgentPath = path.join(
			pluginDir,
			"com.github.copilot",
			"agents",
			"agent-issues.agent.md"
		);
		expect(readFileSync(portableCopilotAgentPath, "utf8")).toBe(agentContent);

		const marketplace = JSON.parse(
			readFileSync(path.join(pluginDir, ".github", "plugin", "marketplace.json"), "utf8")
		) as {
			name?: unknown;
			plugins?: unknown;
		};
		const manifest = JSON.parse(readFileSync(path.join(pluginDir, "plugin.json"), "utf8")) as {
			version?: unknown;
		};
		expect(marketplace).toMatchObject({
			name: "agent-issues",
			plugins: [{ name: "agent-issues", source: "./", version: manifest.version }]
		});
	});

	it("rejects an MCP server that does not use the global command", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const pluginDir = path.join(targetDir, "plugin");
		buildPlugin(pluginDir);
		const mcpPath = path.join(pluginDir, "mcp.json");
		const mcpConfiguration = JSON.parse(readFileSync(mcpPath, "utf8")) as {
			mcpServers: Record<string, { command: string; args: string[] }>;
		};
		mcpConfiguration.mcpServers["agent-issues"].command = "npx";
		mcpConfiguration.mcpServers["agent-issues"].args = ["-y", "agent-issues-mcp"];
		writeFileSync(mcpPath, JSON.stringify(mcpConfiguration));

		const validation = spawnSync(
			process.execPath,
			["scripts/build-plugin.mjs", "--validate-dir", pluginDir],
			{ encoding: "utf8" }
		);

		expect(validation.status).toBe(1);
		expect(validation.stderr).toContain("agent-issues MCP server command must be agent-issues-mcp");
	});

	it("rejects a missing canonical shared asset", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const sourceDir = path.join(targetDir, "source");
		const pluginDir = path.join(targetDir, "plugin");
		copyPluginSource(sourceDir);
		rmSync(path.join(sourceDir, "skills", "agent-issues-operating-contract.md"));

		const build = spawnSync(
			process.execPath,
			[
				"scripts/build-plugin.mjs",
				"--source-dir",
				sourceDir,
				"--target-dir",
				pluginDir
			],
			{ encoding: "utf8" }
		);

		expect(build.status).toBe(1);
		expect(build.stderr).toContain("Required plugin asset not found");
		expect(existsSync(pluginDir)).toBe(false);
	});

	it("rejects a field outside the portable manifest schema", () => {
		targetDir = mkdtempSync(path.join(tmpdir(), "agent-issues-plugin-"));
		const pluginDir = path.join(targetDir, "plugin");
		buildPlugin(pluginDir);
		const manifestPath = path.join(pluginDir, "plugin.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.skills = "./skills/";
		writeFileSync(manifestPath, JSON.stringify(manifest));

		const validation = spawnSync(
			process.execPath,
			["scripts/build-plugin.mjs", "--validate-dir", pluginDir],
			{ encoding: "utf8" }
		);

		expect(validation.status).toBe(1);
		expect(validation.stderr).toContain("unsupported portable field: skills");
	});

});

function copyPluginSource(sourceDir: string): void {
	mkdirSync(sourceDir);
	for (const sourcePath of ["skills", "package.json", "plugin", ".github"]) {
		cpSync(sourcePath, path.join(sourceDir, sourcePath), { recursive: true });
	}
}

function buildPlugin(pluginDir: string, sourceDir = process.cwd(), development = false): void {
	execFileSync(
		process.execPath,
		[
			"scripts/build-plugin.mjs",
			"--source-dir",
			sourceDir,
			"--target-dir",
			pluginDir,
			...(development ? ["--development"] : [])
		],
		{ stdio: "pipe" }
	);
}