import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { launchDetachedLiveSite } from "./site.js";

describe("launchDetachedLiveSite", () => {
	it("spawns a detached foreground server and waits until it is reachable", async () => {
		const child = new EventEmitter() as EventEmitter & { exitCode?: number | null; unref: () => void };
		child.unref = vi.fn();
		const spawnProcess = vi.fn(() => {
			queueMicrotask(() => child.emit("spawn"));
			return child;
		});

		let markReady: () => void;
		const ready = new Promise<void>((resolve) => {
			markReady = resolve;
		});
		const readinessProbe = vi.fn(() => ready);
		const pending = launchDetachedLiveSite(
			{ cwd: "/workspace", dbPath: "/workspace/issues.db", entryPoint: "/workspace/cli.js", port: 4317 },
			spawnProcess,
			readinessProbe
		);
		await vi.waitFor(() => expect(readinessProbe).toHaveBeenCalledWith("http://127.0.0.1:4317"));
		let settled = false;
		void pending.finally(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		markReady!();
		const result = await pending;

		expect(spawnProcess).toHaveBeenCalledWith(
			process.execPath,
			["/workspace/cli.js", "site", "--foreground", "--port", "4317", "--db", "/workspace/issues.db"],
			expect.objectContaining({ cwd: "/workspace", detached: true, stdio: "ignore" })
		);
		expect(child.unref).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ port: 4317, started: true, url: "http://127.0.0.1:4317" });
	});

	it("reports a readiness failure instead of claiming the detached site started", async () => {
		const child = new EventEmitter() as EventEmitter & { unref: () => void };
		child.unref = vi.fn();
		const spawnProcess = vi.fn(() => {
			queueMicrotask(() => child.emit("spawn"));
			return child;
		});

		await expect(launchDetachedLiveSite(
			{ cwd: "/workspace", entryPoint: "/workspace/cli.js", port: 4317 },
			spawnProcess,
			async () => { throw new Error("Live site did not become reachable."); }
		)).rejects.toThrow("Live site did not become reachable.");
		expect(child.unref).not.toHaveBeenCalled();
	});

	it("reports when the detached child exits before readiness", async () => {
		const child = new EventEmitter() as EventEmitter & { exitCode?: number | null; unref: () => void };
		child.unref = vi.fn();
		const spawnProcess = vi.fn(() => {
			queueMicrotask(() => {
				child.emit("spawn");
				child.exitCode = 1;
				child.emit("exit", 1);
			});
			return child;
		});

		await expect(launchDetachedLiveSite(
			{ cwd: "/workspace", entryPoint: "/workspace/cli.js", port: 4317 },
			spawnProcess,
			() => new Promise<void>(() => {})
		)).rejects.toThrow("exited before it became reachable with code 1");
		expect(child.unref).not.toHaveBeenCalled();
	});

	it("reports an immediate spawn failure", async () => {
		const child = new EventEmitter() as EventEmitter & { unref: () => void };
		child.unref = vi.fn();
		const spawnProcess = vi.fn(() => {
			queueMicrotask(() => child.emit("error", new Error("spawn failed")));
			return child;
		});

		await expect(
			launchDetachedLiveSite({ cwd: "/workspace", entryPoint: "/workspace/cli.js", port: 4317 }, spawnProcess)
		).rejects.toThrow("spawn failed");
		expect(child.unref).not.toHaveBeenCalled();
	});
});