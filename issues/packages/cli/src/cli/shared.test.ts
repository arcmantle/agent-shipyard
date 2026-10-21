import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }));

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));

afterEach(() => {
	mocks.readFile.mockReset();
});

describe("resolveMarkdownFileOption", () => {
	it("retries a body-file read after EAGAIN", async () => {
		const error = Object.assign(new Error("resource temporarily unavailable"), { code: "EAGAIN" });
		mocks.readFile.mockRejectedValueOnce(error).mockResolvedValueOnce("Body text");

		expect(await resolveMarkdownFileOption("body.md", "--body-file")).toBe("Body text");
		expect(mocks.readFile).toHaveBeenCalledTimes(2);
	});

	it("reads all piped stdin chunks", async () => {
		async function* pipe(): AsyncGenerator<string> {
			yield "## Purpose\n\n";
			yield "Piped body text\n";
		}

		expect(await resolveMarkdownFileOption("-", "--body-file", pipe())).toBe("## Purpose\n\nPiped body text\n");
	});
});

const openStorageDriverMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/open-storage-driver.js", () => ({ openStorageDriver: openStorageDriverMock }));

const readBuildContentHashMock = vi.hoisted(() => vi.fn(() => "test-build-hash"));
vi.mock("@agent-issues/api-local", () => ({ readBuildContentHash: readBuildContentHashMock }));

const { resolveMarkdownFileOption, withStore } = await import("./shared.js");

function fakeStore() {
	return { close: vi.fn(async () => {}) } as never;
}

describe("withStore (ISS190)", () => {
	it("passes this install's build-content-hash to openStorageDriver's daemon routing", async () => {
		openStorageDriverMock.mockResolvedValue({ store: fakeStore(), dbPath: "/tmp/agent-issues.db" });

		await withStore(undefined, undefined, async () => undefined);

		expect(openStorageDriverMock).toHaveBeenCalledWith(
			expect.objectContaining({ localDaemon: { buildHash: "test-build-hash" } })
		);
	});

});
