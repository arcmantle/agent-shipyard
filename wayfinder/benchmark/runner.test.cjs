const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {settings, readJSON, executeBounded, compareReports, checkRuntime, dockerJob, snapshot} = require("./runner.cjs");

test("benchmark configuration keeps hard resource and disk bounds", () => {
	const base = {image: "node:22-bookworm"};
	assert.equal(settings(base).sources, 10);
	assert.equal(settings({...base, sources: 10000, memoryMiB: 2048}).minFreeGiB, 20);
	for (const change of [{memoryMiB: 8192}, {cpus: 3}, {timeoutSeconds: 201},
		{sources: 10001}, {sources: 9}, {sources: 10000, minFreeGiB: 19},
		{image: "--privileged"}, {unexpected: true}, {outputDirectory: "invalid,path"}]) {
		assert.throws(() => settings({...base, ...change}));
	}
});

test("Docker jobs save evidence before owned cleanup and retain resources after export failure", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "awf-contract-"));
	try {
		for (const exportFails of [false, true]) {
			const commands = [];
			const request = async (config, args) => {
				commands.push(args);
				if (args[0] === "inspect") return JSON.stringify({Running: false, ExitCode: 0, OOMKilled: false});
				if (args[0] === "run") {
					if (exportFails) throw Error("Export failed");
					return JSON.stringify({failure: null});
				}
				if (args[0] === "rm") {
					assert.ok(fs.readdirSync(directory).some(name => fs.existsSync(path.join(directory, name, "evidence.json"))));
				}
				return "";
			};
			const result = await dockerJob(settings({image: "cached", outputDirectory: directory}), "image",
				{files: [], command: []}, request);
			assert.equal(result.cleanup, !exportFails);
			assert.equal(result.retainedResources, exportFails);
			assert.equal(commands.some(args => args[0] === "volume" && args[1] === "rm"), !exportFails);
			assert.ok(commands.find(args => args[0] === "create").includes("--read-only"));
		}
	} finally {
		fs.rmSync(directory, {recursive: true});
	}
});

test("runtime checks reject shared storage, low disk space and incorrect cgroup limits", () => {
	const config = settings({image: "node:22-bookworm"});
	const group = {memory: 1073741824, swap: 0, pids: 128, cpus: 2};
	checkRuntime(config, 0xef53, 1024 ** 3, group);
	assert.throws(() => checkRuntime(config, 1702057286, 1024 ** 3, group));
	assert.throws(() => checkRuntime(config, 0xef53, 1024 ** 3 - 1, group));
	for (const key of Object.keys(group)) {
		assert.throws(() => checkRuntime(config, 0xef53, 1024 ** 3, {...group, [key]: group[key] + 1}));
	}
});

function report(label, startSeconds) {
	const checksum = "sha256:" + "a".repeat(64);
	return {label, sources: 10, binarySha256: "b".repeat(64), failure: null,
		startedAt: `2026-10-05T00:00:0${startSeconds}.000Z`,
		finishedAt: `2026-10-05T00:00:0${startSeconds + 1}.000Z`,
		build: {sourceHash: "c".repeat(64), toolchain: "go1.27.1 linux/arm64", imageId: "image",
			binaries: {baseline: {sha256: "b".repeat(64)}, variant: {sha256: "b".repeat(64)}}},
		limits: {memoryBytes: 1073741824, swapBytes: 0}, runtime: {filesystem: 0xef53},
		container: {ExitCode: 0, OOMKilled: false, Running: false}, child: {status: 0, error: null},
		benchmark: {result: {configuration: {nodeFtsEnabled: true}, outputChecksum: checksum,
			runs: [{sourceFiles: 10, nodeCount: 1000, edgeCount: 2000, databaseBytes: 1000, outputChecksum: checksum}],
			measurements: ["initial_index", "incremental_update", "query", "path", "inspect"]
				.map(name => ({name, durationNs: 1000000})), phaseMeasurements: []}}};
}

test("comparison requires successful matching graph, source, toolchain and execution contracts", () => {
	const before = report("baseline", 0);
	const after = report("variant", 2);
	assert.equal(compareReports(before, after).measurements[0].savedSeconds, 0);
	for (const mutate of [value => { value.container.OOMKilled = true; },
		value => { value.build.sourceHash = "d".repeat(64); },
		value => { value.build.toolchain = "different"; },
		value => { value.limits.swapBytes = 1; },
		value => { value.benchmark.result.runs[0].nodeCount = 999; },
		value => { value.benchmark.result.outputChecksum = "sha256:" + "d".repeat(64); },
		value => { value.benchmark.result.measurements[0].durationNs = NaN; }]) {
		const invalid = structuredClone(after);
		mutate(invalid);
		assert.throws(() => compareReports(before, invalid));
	}
});

test("bounded execution retains partial progress and rejects failed or excessive output", async () => {
	const success = await executeBounded(process.execPath, ["-e", "console.log('ok')"]);
	assert.equal(success.status, 0);
	assert.equal(success.stdout, "ok\n");
	for (const stream of ["stdout", "stderr"]) {
		const result = await executeBounded(process.execPath,
			["-e", `process.${stream}.write('x'.repeat(65537))`]);
		assert.match(result.error, /exceeds 64 KiB/);
		assert.ok(Buffer.byteLength(result[stream]) <= 65536);
	}
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "awf-progress-"));
	try {
		const logFile = path.join(directory, "progress.log");
		const timeout = await executeBounded(process.execPath,
			["-e", "process.stderr.write('progress\\n');process.stdin.resume()"], {timeoutMs: 150, logFile});
		assert.equal(timeout.error, "Deadline exceeded");
		assert.equal(fs.readFileSync(logFile, "utf8"), "progress\n");
	} finally { fs.rmSync(directory, {recursive: true}); }
	const interrupted = executeBounded(process.execPath, ["-e", "process.stdin.resume()"]);
	process.emit("SIGINT");
	assert.equal((await interrupted).error, "Interrupted");
	const failure = await executeBounded(process.execPath, ["-e", "process.exit(7)"]);
	assert.equal(failure.status, 7);
});

test("report reading and source snapshots reject unbounded or mutable inputs", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "awf-input-"));
	try {
		const filename = path.join(directory, "report.json");
		fs.writeFileSync(filename, "{}");
		assert.deepEqual(readJSON(filename), {});
		fs.writeFileSync(filename, " ".repeat(65537));
		assert.throws(() => readJSON(filename));
		assert.throws(() => readJSON(directory));
		const {execFileSync} = require("node:child_process");
		execFileSync("git", ["init", "--quiet", directory]);
		const config = settings({image: "cached", sourceDirectory: directory});
		const before = snapshot(config);
		fs.writeFileSync(filename, "changed");
		assert.notEqual(snapshot(config), before);
		fs.writeFileSync(path.join(directory, "agent-wayfinder"), Buffer.alloc(8388609));
		assert.equal(snapshot(config), snapshot(config, path.join(directory, ".git", "snapshot")));
	} finally { fs.rmSync(directory, {recursive: true}); }
});