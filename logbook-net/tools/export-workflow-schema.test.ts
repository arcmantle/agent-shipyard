import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { exportWorkflowSchema, resourceFile } from "./export-workflow-schema.ts";

test("the embedded workflow schema is the export of the recorded TypeScript result", () => {
	expect(readFileSync(resourceFile, "utf8")).toBe(exportWorkflowSchema());
});

test("the export names the new command and keeps the retained inputs", () => {
	const text = exportWorkflowSchema();
	expect(text).toContain("agent-logbook context list --json");
	expect(text).not.toContain("agent-issues context");
});
