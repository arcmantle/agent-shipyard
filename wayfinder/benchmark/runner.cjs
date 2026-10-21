const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {spawn, execFileSync} = require("node:child_process");
const crypto = require("node:crypto");

const outputLimit = 65536;

function settings(input, directory = process.cwd()) {
	const allowed = ["image", "context", "outputDirectory", "sourceDirectory", "sources",
		"memoryMiB", "cpus", "timeoutSeconds", "minFreeGiB", "baselineDriver", "variantDriver",
		"goSDKDirectory", "moduleCacheDirectory", "buildCacheDirectory"];
	for (const key of Object.keys(input)) assert.ok(allowed.includes(key), `Unknown setting: ${key}`);
	const result = {...input, sources: input.sources ?? 10, memoryMiB: input.memoryMiB ?? 1024,
		cpus: input.cpus ?? 2, timeoutSeconds: input.timeoutSeconds ?? 200};
	assert.ok(Number.isInteger(result.sources) && result.sources >= 10 && result.sources <= 10000,
		"sources must be an integer from 10 to 10000");
	assert.ok([1024, 2048].includes(result.memoryMiB), "memoryMiB must be 1024 or 2048");
	assert.ok([1, 2].includes(result.cpus), "cpus must be 1 or 2");
	assert.ok(Number.isInteger(result.timeoutSeconds) && result.timeoutSeconds >= 1
		&& result.timeoutSeconds <= 200, "timeoutSeconds must be an integer from 1 to 200");
	const requiredGiB = result.sources >= 10000 ? 20 : result.sources >= 1000 ? 5 : 1;
	result.minFreeGiB = input.minFreeGiB ?? requiredGiB;
	assert.ok(Number.isInteger(result.minFreeGiB) && result.minFreeGiB >= requiredGiB
		&& result.minFreeGiB <= 100, `minFreeGiB must be from ${requiredGiB} to 100`);
	assert.match(result.image ?? "", /^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$/, "A cached Linux image is required");
	if (result.context !== undefined) assert.match(result.context, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
	for (const key of ["baselineDriver", "variantDriver"]) {
		if (result[key] !== undefined) assert.match(result[key], /^v[0-9][a-zA-Z0-9.+-]*$/);
	}
	result.outputDirectory = input.outputDirectory ?? ".benchmark-output";
	result.sourceDirectory = input.sourceDirectory ?? path.resolve(__dirname, "..");
	for (const key of ["outputDirectory", "sourceDirectory", "goSDKDirectory", "moduleCacheDirectory", "buildCacheDirectory"]) {
		if (result[key] === undefined) continue;
		assert.equal(typeof result[key], "string");
		assert.ok(result[key].length > 0 && !/[\r\n,]/.test(result[key]), `Invalid path: ${key}`);
		result[key] = path.resolve(directory, result[key]);
	}
	return result;
}

function readJSON(filename) {
	assert.ok(fs.lstatSync(filename).isFile(), "JSON must be a regular file");
	const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
	try {
		assert.ok(!fs.lstatSync(filename).isSymbolicLink(), "Report must not be a symbolic link");
		const metadata = fs.fstatSync(descriptor);
		assert.ok(metadata.isFile() && metadata.size <= outputLimit, "JSON file exceeds 64 KiB");
		const contents = Buffer.alloc(outputLimit + 1);
		const bytes = fs.readSync(descriptor, contents, 0, contents.length, null);
		assert.ok(bytes <= outputLimit && bytes === metadata.size, "JSON file changed while reading");
		return JSON.parse(contents.subarray(0, bytes));
	} finally {
		fs.closeSync(descriptor);
	}
}

function executeBounded(command, args, {timeoutMs = 30000, progress = false, cwd, env, logFile} = {}) {
	return new Promise(resolve => {
		const log = logFile ? fs.openSync(logFile, "wx") : null;
		const child = spawn(command, args, {cwd, env});
		const chunks = {stdout: [], stderr: []};
		const sizes = {stdout: 0, stderr: 0};
		let error = null;
		let stopped = false;
		let killTimer;
		let validationStart;
		let validationSeconds = null;
		let pending = "";
		const stop = reason => {
			error ??= reason;
			if (stopped) return;
			stopped = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
		};
		const interrupt = () => stop("Interrupted");
		process.once("SIGINT", interrupt);
		process.once("SIGTERM", interrupt);
		const timer = setTimeout(() => stop("Deadline exceeded"), timeoutMs);
		for (const stream of ["stdout", "stderr"]) {
			child[stream].on("data", contents => {
				sizes[stream] += contents.length;
				if (sizes[stream] > outputLimit) return stop(`${stream} exceeds 64 KiB`);
				chunks[stream].push(contents);
				if (stream === "stderr") {
					const lines = (pending + contents.toString("utf8")).split("\n");
					pending = lines.pop();
					for (const line of lines) {
						if (line === "Benchmark run 1/1: validation") validationStart = performance.now();
						if (line === "Benchmark run 1/1: incremental_update" && validationStart !== undefined)
							validationSeconds = (performance.now() - validationStart) / 1000;
					}
				}
				if (progress && stream === "stderr") process.stderr.write(contents);
				if (log !== null && stream === "stderr") {
					try { fs.writeSync(log, contents); }
					catch (failure) { stop(failure.message); }
				}
			});
		}
		child.on("error", value => { error ??= value.message; });
		child.on("close", (status, signal) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			process.removeListener("SIGINT", interrupt);
			process.removeListener("SIGTERM", interrupt);
			if (log !== null) fs.closeSync(log);
			resolve({status, signal, error, validationSeconds,
				stdout: Buffer.concat(chunks.stdout).toString("utf8"),
				stderr: Buffer.concat(chunks.stderr).toString("utf8")});
		});
	});
}

function validateReport(report) {
	assert.equal(report.failure, null, "Run failed");
	assert.equal(report.container.ExitCode, 0, "Container failed");
	assert.equal(report.container.OOMKilled, false, "Container ran out of memory");
	assert.equal(report.container.Running, false, "Container is still running");
	assert.equal(report.child.status, 0, "Benchmark failed");
	assert.equal(report.child.error, null);
	assert.match(report.build.sourceHash, /^[a-f0-9]{64}$/);
	assert.equal(report.binarySha256, report.build.binaries[report.label].sha256);
	const result = report.benchmark.result;
	assert.ok(!result.failure);
	assert.equal(result.runs.length, 1);
	const run = result.runs[0];
	assert.equal(run.sourceFiles, report.sources);
	assert.equal(run.nodeCount, report.sources * 100);
	assert.equal(run.edgeCount, report.sources * 200);
	assert.equal(result.configuration.nodeFtsEnabled, true);
	assert.ok(run.databaseBytes > 0 && run.databaseBytes <= 4294967296);
	assert.match(run.outputChecksum, /^sha256:[a-f0-9]{64}$/);
	assert.match(result.outputChecksum, /^sha256:[a-f0-9]{64}$/);
	assert.deepEqual(result.measurements.map(value => value.name),
		["initial_index", "incremental_update", "query", "path", "inspect"]);
	for (const value of [...result.measurements, ...result.phaseMeasurements]) {
		assert.ok(Number.isFinite(value.durationNs) && value.durationNs >= 0);
	}
	return result;
}

function compareReports(before, after) {
	const oldResult = validateReport(before);
	const newResult = validateReport(after);
	for (const key of ["sourceHash", "toolchain", "imageId"]) assert.deepEqual(before.build[key], after.build[key], key);
	for (const key of ["limits", "runtime", "sources"]) assert.deepEqual(before[key], after[key], key);
	assert.ok(Number.isFinite(Date.parse(before.startedAt)) && Number.isFinite(Date.parse(after.finishedAt)));
	assert.ok(Date.parse(before.finishedAt) <= Date.parse(after.startedAt), "Samples must run sequentially");
	assert.deepEqual(oldResult.configuration, newResult.configuration);
	assert.equal(oldResult.outputChecksum, newResult.outputChecksum, "Complete checksums differ");
	assert.equal(oldResult.runs[0].outputChecksum, newResult.runs[0].outputChecksum);
	const differences = field => {
		assert.deepEqual(oldResult[field].map(value => value.name), newResult[field].map(value => value.name));
		return oldResult[field].map((value, index) => ({name: value.name,
			beforeSeconds: value.durationNs / 1e9, afterSeconds: newResult[field][index].durationNs / 1e9,
			savedSeconds: (value.durationNs - newResult[field][index].durationNs) / 1e9}));
	};
	return {sources: before.sources, outputChecksum: oldResult.outputChecksum,
		measurements: differences("measurements"), phases: differences("phaseMeasurements"),
		caveat: "One pair is not a stable or causal performance estimate. Phase timings can overlap."};
}

function checkRuntime(config, filesystem, availableBytes, cgroup) {
	assert.equal(filesystem, 0xef53, "Use a VM-local ext4 Docker volume, not a shared host directory");
	assert.ok(availableBytes >= config.minFreeGiB * 1024 ** 3, "Insufficient free space in Docker volume");
	assert.equal(cgroup.memory, config.memoryMiB * 1024 ** 2, "Wrong memory limit");
	assert.equal(cgroup.swap, 0, "Swap must be disabled");
	assert.equal(cgroup.pids, 128, "Wrong PID limit");
	assert.equal(cgroup.cpus, config.cpus, "Wrong CPU limit");
}

function writeJSON(filename, value) {
	const contents = JSON.stringify(value, null, 2) + "\n";
	assert.ok(Buffer.byteLength(contents) <= outputLimit, "Report exceeds 64 KiB");
	fs.writeFileSync(filename, contents, {flag: "wx"});
}

async function worker(config, label) {
	assert.ok(["baseline", "variant"].includes(label));
	const report = {failure: null};
	try {
		const stats = fs.statfsSync("/work");
		const readGroup = name => fs.readFileSync(`/sys/fs/cgroup/${name}`, "utf8").trim();
		const [quota, period] = readGroup("cpu.max").split(" ").map(Number);
		checkRuntime(config, stats.type, stats.bavail * stats.bsize, {
			memory: Number(readGroup("memory.max")), swap: Number(readGroup("memory.swap.max")),
			pids: Number(readGroup("pids.max")), cpus: quota / period});
		report.runtime = {filesystem: stats.type, architecture: process.arch, node: process.version};
		report.availableBytes = stats.bavail * stats.bsize;
		fs.mkdirSync("/work/scratch");
		process.env.TMPDIR = "/work/scratch";
		report.binarySha256 = hashFile(`/work/${label}`);
		report.child = await executeBounded(`/work/${label}`, ["benchmark", "--source-files", String(config.sources),
			"--runs", "1", "--fts=true", "--internal-sample", "--format", "json"],
			{timeoutMs: Math.max(1, config.timeoutSeconds - 2) * 1000, progress: true});
		fs.writeFileSync("/work/progress.log", report.child.stderr, {flag: "wx"});
		report.cgroup = {memoryPeakBytes: Number(readGroup("memory.peak")),
			memoryEvents: Object.fromEntries(readGroup("memory.events").split("\n").map(line => {
				const [name, value] = line.split(/\s+/);
				return [name, Number(value)];
			}))};
		if (report.child.stdout) report.benchmark = JSON.parse(report.child.stdout);
		assert.equal(report.child.error, null);
		assert.equal(report.child.status, 0);
	} catch (error) {
		report.failure = error.message;
	} finally {
		if (report.child) {
			delete report.child.stdout;
			delete report.child.stderr;
		}
		writeJSON("/work/worker.json", report);
	}
	if (report.failure) process.exitCode = 1;
}

async function docker(config, args, options) {
	const result = await executeBounded("docker", [...(config.context ? ["--context", config.context] : []), ...args], options);
	assert.equal(result.error, null, result.error ?? "Docker command failed");
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

function containerLimits(config) {
	return ["--memory", `${config.memoryMiB}m`, "--memory-swap", `${config.memoryMiB}m`,
		"--cpus", String(config.cpus), "--pids-limit", "128", "--ulimit", "core=0:0",
		"--ulimit", "fsize=4294967296:4294967296", "--ulimit", `cpu=${config.timeoutSeconds * config.cpus}:${config.timeoutSeconds * config.cpus}`,
		"--network", "none", "--read-only", "--log-driver", "none", "--init",
		"--tmpfs", "/tmp:rw,exec,size=268435456"];
}

async function dockerJob(config, imageId, {files, command, mounts = [], exportBinaries = false}, request = docker) {
	fs.mkdirSync(config.outputDirectory, {recursive: true});
	const directory = fs.mkdtempSync(path.join(config.outputDirectory, "job-"));
	const name = `awf-benchmark-${crypto.randomUUID()}`;
	const evidence = {containerName: name, volumeName: name, directory, failure: null, cleanup: false};
	let volumeCreated = false;
	let containerCreated = false;
	try {
		await request(config, ["volume", "create", "--label", `awf-benchmark.owner=${name}`, name]);
		volumeCreated = true;
		await request(config, ["create", "--pull=never", "--name", name, "--label", `awf-benchmark.owner=${name}`,
			...containerLimits(config), "--mount", `type=volume,source=${name},target=/work`, ...mounts,
			"--workdir", "/work", "--env", `GOMAXPROCS=${config.cpus}`, "--env", "GOGC=", "--env", "GOMEMLIMIT=",
			"--env", "GODEBUG=", "--entrypoint", "/usr/bin/timeout", imageId, "--kill-after=1s",
			`${config.timeoutSeconds}s`, "node", "--max-old-space-size=32", ...command]);
		containerCreated = true;
		for (const [source, target] of files) await request(config, ["cp", source, `${name}:/work/${target}`]);
		evidence.startedAt = new Date().toISOString();
		try {
			await request(config, ["start", "--attach", name], {timeoutMs: config.timeoutSeconds * 1000,
				progress: true, logFile: path.join(directory, "attached.log")});
		} catch (error) {
			evidence.failure = error.message;
			await request(config, ["kill", name]).catch(() => {});
		}
		evidence.finishedAt = new Date().toISOString();
		evidence.container = JSON.parse(await request(config, ["inspect", "--format", "{{json .State}}", name]));
		assert.equal(evidence.container.Running, false, "Container must stop before report export");
		const readerArgs = ["run", "--pull=never", "--rm", ...containerLimits({...config, timeoutSeconds: 20}),
			"--mount", `type=volume,source=${name},target=/work,readonly`, "--entrypoint", "/usr/bin/timeout",
			imageId, "--kill-after=1s", "20s", "node", "--max-old-space-size=32", "-e"];
		evidence.worker = JSON.parse(await request(config, [...readerArgs,
			'console.log(JSON.stringify(require("/work/runner.cjs").readJSON("/work/worker.json")))']));
		if (evidence.worker.child) {
			const log = await request(config, [...readerArgs,
				'const fs=require("fs");const stat=fs.lstatSync("/work/progress.log");if(!stat.isFile()||stat.size>65536)throw Error("Invalid log");process.stdout.write(fs.readFileSync("/work/progress.log"))']);
			fs.writeFileSync(path.join(directory, "progress.log"), log, {flag: "wx"});
		}
		if (exportBinaries && !evidence.worker.failure) {
			for (const label of ["baseline", "variant"]) {
				const expected = evidence.worker.binaries[label];
				assert.ok(expected.size > 0 && expected.size <= 67108864);
				const filename = path.join(directory, label);
				await request(config, ["cp", `${name}:/work/${label}`, filename]);
				assert.equal(hashFile(filename), expected.sha256);
			}
		}
		writeJSON(path.join(directory, "evidence.json"), evidence);
		await request(config, ["rm", name]);
		containerCreated = false;
		await request(config, ["volume", "rm", name]);
		volumeCreated = false;
		evidence.cleanup = true;
	} catch (error) {
		evidence.failure ??= error.message;
	} finally {
		if (containerCreated) await request(config, ["kill", name]).catch(() => {});
		evidence.retainedResources = volumeCreated;
		writeJSON(path.join(directory, "job.json"), evidence);
	}
	return evidence;
}

function hashFile(filename, limit = 67108864) {
	assert.ok(fs.lstatSync(filename).isFile(), "Expected a regular file");
	const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
	try {
		const metadata = fs.fstatSync(descriptor);
		assert.ok(metadata.isFile() && metadata.size <= limit, "File exceeds size limit");
		const digest = crypto.createHash("sha256");
		const buffer = Buffer.alloc(outputLimit);
		let total = 0;
		let bytes;
		while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
			total += bytes;
			assert.ok(total <= limit, "File grew beyond size limit");
			digest.update(buffer.subarray(0, bytes));
		}
		assert.equal(total, metadata.size, "File changed while hashing");
		return digest.digest("hex");
	} finally {
		fs.closeSync(descriptor);
	}
}

function snapshot(config, destination) {
	const names = [...new Set(execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"],
		{cwd: config.sourceDirectory, maxBuffer: 262144, timeout: 30000, encoding: "utf8"})
		.split("\0").filter(name => name && !["agent-wayfinder", "agent-wayfinder.test"].includes(name)))].sort();
	assert.ok(names.length <= 4096);
	const digest = crypto.createHash("sha256");
	let bytes = 0;
	for (const name of names) {
		assert.ok(!name.split(/[\\/]/).includes("..") && !path.isAbsolute(name));
		const source = path.join(config.sourceDirectory, name);
		const sha256 = hashFile(source, 8388608);
		bytes += fs.statSync(source).size;
		assert.ok(bytes <= 134217728, "Source snapshot exceeds 128 MiB");
		digest.update(name + "\0" + sha256 + "\0");
		if (destination) {
			const target = path.join(destination, name);
			fs.mkdirSync(path.dirname(target), {recursive: true});
			fs.copyFileSync(source, target);
			assert.equal(hashFile(target, 8388608), sha256, "Source changed while copying");
		}
	}
	return digest.digest("hex");
}

async function buildWorker(config) {
	const report = {failure: null, binaries: {}};
	try {
		const stats = fs.statfsSync("/work");
		assert.equal(stats.type, 0xef53);
		assert.ok(stats.bavail * stats.bsize >= config.minFreeGiB * 1024 ** 3);
		const go = config.goSDKDirectory ? "/sdk/bin/go" : "go";
		const env = {...process.env, GOWORK: "off", GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off",
			CGO_ENABLED: "1", CGO_LDFLAGS: "-lm", GOCACHE: "/cache",
			...(config.moduleCacheDirectory ? {GOMODCACHE: "/mod"} : {})};
		const run = async args => {
			const result = await executeBounded(go, args, {cwd: "/work/source", env, timeoutMs: config.timeoutSeconds * 1000});
			assert.equal(result.error, null);
			assert.equal(result.status, 0, result.stderr);
			return result.stdout;
		};
		report.toolchain = JSON.parse(await run(["env", "-json", "GOVERSION", "GOOS", "GOARCH", "CC", "CGO_ENABLED"]));
		report.toolchain.executableSha256 = hashFile(path.join((await run(["env", "GOROOT"])).trim(), "bin", "go"));
		const original = fs.readFileSync("/work/source/go.mod");
		for (const label of ["baseline", "variant"]) {
			fs.writeFileSync("/work/source/go.mod", original);
			const version = config[`${label}Driver`];
			assert.ok(version, "Both driver versions are required");
			await run(["mod", "edit", `-require=github.com/arcmantle/go-sqlite3@${version}`]);
			await run(["build", "-p=1", "-trimpath", "-buildvcs=false", "-o", `/work/${label}`, "./cmd/agent-wayfinder"]);
			const metadata = JSON.parse(await run(["version", "-m", "-json", `/work/${label}`]));
			const driver = metadata.Deps.find(value => value.Path === "github.com/arcmantle/go-sqlite3");
			assert.equal(driver.Version, version);
			assert.ok(!metadata.Deps.some(value => value.Replace), "Replaced dependencies are not supported");
			report.binaries[label] = {sha256: hashFile(`/work/${label}`), size: fs.statSync(`/work/${label}`).size, metadata};
		}
		const normalize = info => ({...info, Deps: info.Deps.filter(value => value.Path !== "github.com/arcmantle/go-sqlite3")});
		assert.deepEqual(normalize(report.binaries.baseline.metadata), normalize(report.binaries.variant.metadata));
	} catch (error) {
		report.failure = error.message.slice(0, 2048);
	} finally {
		writeJSON("/work/worker.json", report);
	}
	if (report.failure) process.exitCode = 1;
}

async function cachedImage(config) {
	const image = JSON.parse(await docker(config, ["image", "inspect", "--format", "{{json .}}", config.image]));
	assert.equal(image.Os, "linux", "A cached Linux image is required");
	return image.Id;
}

async function buildPair(config) {
	assert.ok(config.baselineDriver && config.variantDriver, "Set both driver versions");
	const imageId = await cachedImage(config);
	fs.mkdirSync(config.outputDirectory, {recursive: true});
	const directory = fs.mkdtempSync(path.join(config.outputDirectory, "pair-"));
	const sourceHash = snapshot(config, path.join(directory, "source"));
	const configFile = path.join(directory, "config.json");
	writeJSON(configFile, config);
	const mounts = [];
	for (const [key, target, readonly] of [["goSDKDirectory", "/sdk", true],
		["moduleCacheDirectory", "/mod", true], ["buildCacheDirectory", "/cache", false]]) {
		if (config[key]) mounts.push("--mount", `type=bind,source=${config[key]},target=${target}${readonly ? ",readonly" : ""}`);
	}
	if (!config.buildCacheDirectory) mounts.push("--tmpfs", "/cache:rw,size=268435456");
	const job = await dockerJob(config, imageId, {mounts, exportBinaries: true,
		files: [[__filename, "runner.cjs"], [configFile, "config.json"], [path.join(directory, "source"), "source"]],
		command: ["/work/runner.cjs", "build-worker"]});
	assert.equal(job.failure, null, `Build failed; evidence: ${job.directory}`);
	assert.equal(job.container.ExitCode, 0, job.worker.failure);
	assert.equal(job.container.OOMKilled, false);
	assert.equal(job.worker.failure, null);
	assert.equal(snapshot(config), sourceHash, "Source changed during build");
	const manifest = {...job.worker, imageId, sourceHash,
		binaryDirectory: path.relative(directory, job.directory),
		drivers: {baseline: config.baselineDriver, variant: config.variantDriver}};
	const filename = path.join(directory, "manifest.json");
	writeJSON(filename, manifest);
	return filename;
}

async function runSample(config, manifestFile, label) {
	assert.ok(["baseline", "variant"].includes(label));
	const build = readJSON(manifestFile);
	assert.equal(await cachedImage(config), build.imageId, "Build and run images differ");
	const binary = path.resolve(path.dirname(manifestFile), build.binaryDirectory, label);
	assert.equal(hashFile(binary), build.binaries[label].sha256);
	const configFile = path.join(path.dirname(manifestFile), `run-${crypto.randomUUID()}.json`);
	writeJSON(configFile, config);
	const job = await dockerJob(config, build.imageId, {files: [[__filename, "runner.cjs"],
		[configFile, "config.json"], [binary, label]], command: ["/work/runner.cjs", "worker", label]});
	const report = {...job.worker, label, sources: config.sources, build,
		failure: job.failure ?? job.worker?.failure ?? null, container: job.container,
		startedAt: job.startedAt, finishedAt: job.finishedAt,
		limits: {memoryBytes: config.memoryMiB * 1024 ** 2, swapBytes: 0, cpus: config.cpus,
			pids: 128, outputBytes: outputLimit, timeoutSeconds: config.timeoutSeconds, databaseBytes: 4294967296}};
	const filename = path.join(job.directory, "report.json");
	writeJSON(filename, report);
	console.log(filename);
	validateReport(report);
	return filename;
}

async function main(args) {
	const [command, configFile, extra, label] = args;
	if (command === "compare" && args.length === 3) {
		console.log(JSON.stringify(compareReports(readJSON(configFile), readJSON(extra)), null, 2));
		return;
	}
	assert.ok((command === "build" && args.length === 2) || (command === "run" && args.length === 4),
		"Use build <config.json>, run <config.json> <manifest.json> <baseline|variant>, or compare <before.json> <after.json>");
	const config = settings(readJSON(configFile), path.dirname(path.resolve(configFile)));
	if (command === "build") console.log(await buildPair(config));
	else await runSample(config, path.resolve(extra), label);
}

module.exports = {settings, readJSON, executeBounded, validateReport, compareReports, checkRuntime, dockerJob, snapshot};

if (require.main === module && process.argv[2] === "worker") {
	worker(readJSON("/work/config.json"), process.argv[3]).catch(error => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
if (require.main === module && process.argv[2] === "build-worker") {
	buildWorker(readJSON("/work/config.json")).catch(error => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
if (require.main === module && !["worker", "build-worker"].includes(process.argv[2])) {
	main(process.argv.slice(2)).catch(error => {
		console.error(error.message);
		process.exitCode = 1;
	});
}