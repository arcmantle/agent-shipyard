import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadCases } from "./cases.ts";
import { renameVisible, RETAINED_INPUTS } from "./rename.ts";
import { surfaceStatus, SurfaceRuleError, validateRemovals, type Inventory } from "./surfaces.ts";

const netRoot = path.resolve(import.meta.dir, "../..");
const repoRoot = path.resolve(netRoot, "..");
const inventory = JSON.parse(readFileSync(path.join(netRoot, "contract/inventory.json"), "utf8")) as Inventory;
const rawRules = JSON.parse(readFileSync(path.join(netRoot, "contract/surface-rules.json"), "utf8"));
const removals = validateRemovals(rawRules, inventory, repoRoot);
const cases = loadCases(path.join(netRoot, "contract/cases"));
const removed = (kind: string) => removals.filter((rule) => rule.kind === kind).map((rule) => rule.name).sort();

test("the approved removals are exactly the decided surfaces", () => {
	expect(removed("cli-command")).toEqual(["cli:daemon", "cli:synchronize"]);
	expect(removed("host-route")).toEqual(["POST /daemon/stop"]);
	expect(removed("legacy-name")).toEqual([
		"AGENT_ISSUES_DAEMON_IDLE_MS", "AGENT_ISSUES_DB", "AGENT_ISSUES_NO_DAEMON", "agent-issues-daemon", "agent-issues.db", "agent-issues.db-shm", "agent-issues.db-wal",
		"alb", "backups/", "daemon[-<slot>].json", "daemon[-<slot>].lock", "daemonHealth", "x-agent-issues-db-path"
	].sort());
	expect(removed("component")).toEqual(["logbook/docs/mcp-registry-setup.md", "logbook/packages/mcp-server/src/proxy.ts", "logbook/packages/vscode-mcp-provider"]);
});

test("a removal never hides a retained surface", () => {
	const status = surfaceStatus(inventory, removals, cases);
	const removedSurfaces = status.filter((entry) => entry.disposition === "removed").map((entry) => entry.surface).sort();
	expect(removedSurfaces).toEqual(["cli:daemon", "cli:synchronize", "route:POST /daemon/stop"]);
	// Same family, kept: the canonical-chain methods that the synchronize store owns, and the commands that share a name prefix.
	for (const kept of ["rpc:exportCanonicalChains", "rpc:importCanonicalChains", "cli:comment", "cli:auth login", "cli:project-identity", "cli:sql"]) {
		expect(status.find((entry) => entry.surface === kept)?.disposition).not.toBe("removed");
	}
});

test("covered and not-yet-ported surfaces are different from removed ones", () => {
	const status = new Map(surfaceStatus(inventory, removals, cases).map((entry) => [entry.surface, entry.disposition]));
	expect(status.get("cli:project-identity")).toBe("covered");
	expect(status.get("rpc:getEntityDetails")).toBe("covered");
	expect(status.get("cli:auth login")).toBe("not-yet-ported");
	expect(status.get("cli:daemon")).toBe("removed");
});

test("a removal rule that is vague, unknown, or overlaps a retained input is rejected", () => {
	const base = rawRules.removed[0];
	const bad = (change: object) => () => validateRemovals({ removed: [{ ...base, ...change }] }, inventory, repoRoot);
	for (const change of [
		{ name: "cli:*" }, { name: "cli:comment*" }, { name: "cli:no-such-command" }, { kind: "host-route", name: "POST /no/such" }, { kind: "component", name: "logbook/packages/none" },
		{ kind: "other" }, { decision: "later" }, { reason: "" }, { kind: "legacy-name", name: "x" }
	]) expect(bad(change)).toThrow(SurfaceRuleError);
	for (const input of RETAINED_INPUTS) {
		expect(bad({ kind: "legacy-name", category: "file", name: input })).toThrow(/retained/);
	}
	expect(bad({ kind: "legacy-name", category: "file", name: ".agent-issues.js" })).toThrow(/retained/);
	expect(() => validateRemovals({ removed: [base, base] }, inventory, repoRoot)).toThrow(/duplicate/);
	expect(() => validateRemovals({}, inventory, repoRoot)).toThrow(SurfaceRuleError);
});

test("the rename changes every visible case form and keeps the retained inputs", () => {
	const cases: [string, string][] = [
		["agent-issues project-identity", "agent-logbook project-identity"],
		["agentIssues", "agentLogbook"],
		["AGENT_ISSUES_URL", "AGENT_LOGBOOK_URL"],
		["agent_issues", "agent_logbook"],
		["AgentIssues", "AgentLogbook"],
		["Agent Issues", "Agent Logbook"],
		["agent-issues:system", "agent-logbook:system"],
		["x-agent-issues-build-hash", "x-agent-logbook-build-hash"],
		["/.well-known/agent-issues", "/.well-known/agent-logbook"],
		["/__agent_issues/stop", "/__agent_logbook/stop"],
		["ui://agent-issues/issue-preview.html", "ui://agent-logbook/issue-preview.html"]
	];
	for (const [from, to] of cases) expect(renameVisible(from)).toBe(to);
	for (const input of RETAINED_INPUTS) expect(renameVisible(`${input} and ${input}`)).toBe(`${input} and ${input}`);
	expect(renameVisible("agent-issues reads .agent-issues.json, .agent-issues and AGENT_ISSUES_PROJECT_IDENTITY; agent-issues/entity-stable-id/v1"))
		.toBe("agent-logbook reads .agent-issues.json, .agent-issues and AGENT_ISSUES_PROJECT_IDENTITY; agent-issues/entity-stable-id/v1");
});
