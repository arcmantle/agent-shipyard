import { describe, expect, it } from "vitest";

import { runCli } from "../../cli.js";

describe("synchronize CLI command", () => {
	it("is blocked and names the migration command before it opens any store", async () => {
		await expect(runCli(["synchronize"], { cwd: process.cwd() })).rejects.toThrow(/disabled.*agent-issues cloud migrate/s);
	});
});
