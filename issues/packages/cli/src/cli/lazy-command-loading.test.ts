import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

vi.mock("./commands/auth.js", () => {
	throw new Error("The auth command family must not load for project-identity.");
});

const { runCli } = await import("./index.js");

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

describe("lazy command loading", () => {
	it("does not load unrelated command families for a lightweight command", async () => {
		const stdout = createCapture();

		expect(await runCli(["project-identity", "--json"], {
			cwd: process.cwd(),
			stderr: createCapture().stream,
			stdout: stdout.stream
		})).toBe(0);

		expect(JSON.parse(stdout.read())).toMatchObject({ command: "project-identity" });
	});

	it("keeps the complete command catalog available through global JSON help", async () => {
		const stdout = createCapture();

		expect(await runCli(["help", "--json"], {
			cwd: process.cwd(),
			stderr: createCapture().stream,
			stdout: stdout.stream
		})).toBe(0);

		expect(JSON.parse(stdout.read()).commands).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: "auth login" }),
			expect.objectContaining({ name: "project-identity" })
		]));
	});
});