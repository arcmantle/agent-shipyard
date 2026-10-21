# Benchmarks

[Back to the project overview](../README.md)

## Native Diagnostics

Compare node FTS costs with temporary databases:

```bash
make run ARGS='benchmark --exact-scale --source-files 1000 --runs 3 --format json'
make run ARGS='benchmark --exact-scale --source-files 1000 --runs 3 --fts=false --format json'
```

FTS is enabled by default. `--fts=false` skips node lexical snapshot writes
only in the benchmark database. Node lexical search is unavailable there.
Production indexing and its 4 GiB database limit do not change.

Reports include `configuration.nodeFtsEnabled`. Database bytes include the
final checkpoint after the incremental update. Query measurements use direct
graph queries. Failed acceptance checks can still produce a report.

An operation failure returns a nonzero exit code and a partial report.
`failure` identifies the operation and error. Completed timings remain.
`unavailableMeasurements` and `unavailableResources` identify missing data;
unavailable resources have no JSON value.

A partial report is not an acceptance result. Top-level measurements describe
the failed sample, not medians. `runs` retains completed and failed samples.
`databasePath` identifies the retained temporary database. When closing and
checkpointing succeed, `databaseBytes` gives its size. Inspect the database
before you remove the temporary state directory. Successful samples clean up
their temporary files. The live workspace database does not change.

## Bounded Performance Runs

The native commands do not impose a hard memory limit. The repository runner
requires Node.js 22 or later, Git, Docker with Linux cgroup v2, and an ext4
Docker volume. Start Docker with sufficient VM-local disk space before a run.
The runner does not start or resize a VM, change the active Docker context,
pull images, or download modules.

The cached image must provide Node.js, GNU `timeout`, a C compiler, and a Go
SDK. You can instead mount a cached Linux Go SDK. Prepare the image and module
cache before the run. Use a writable build cache. Timed databases and corpora
use a new VM-local volume, not a shared host filesystem.

Put a configuration file in the ignored `.benchmark-output/` directory.
Paths are relative to that file:

```json
{
  "image": "benchmark-linux:local",
  "outputDirectory": ".",
  "sources": 10,
  "memoryMiB": 2048,
  "cpus": 2,
  "timeoutSeconds": 200,
  "baselineDriver": "v1.14.25-arcmantle.0",
  "variantDriver": "v1.14.25-arcmantle.0.0.20261005082234-2c1e659080da",
  "goSDKDirectory": "/path/to/linux-go",
  "moduleCacheDirectory": "/path/to/cached-modules",
  "buildCacheDirectory": "/path/to/build-cache"
}
```

`context` optionally selects a Docker context without changing the active one.
`sourceDirectory` defaults to this repository. Both driver versions must be
cached. The source snapshot contains Git-listed working-tree files, including
untracked, nonignored files. It excludes generated root CLI and test binaries.
Replaced Go dependencies are not supported. Builds disable network access and
automatic toolchain downloads. The build manifest retains binary hashes and
structured dependency and toolchain metadata.

```bash
node benchmark/runner.cjs build .benchmark-output/config.json
node benchmark/runner.cjs run .benchmark-output/config.json <manifest.json> baseline
node benchmark/runner.cjs run .benchmark-output/config.json <manifest.json> variant
node benchmark/runner.cjs compare <baseline-report.json> <variant-report.json>
make benchmark-tools
```

Commands print output paths. Replace placeholders with those paths. Run samples
sequentially with the same configuration.

Defaults are ten sources, 1 GiB RAM, two CPUs, and 200 seconds. Supported memory
caps are 1 and 2 GiB, with swap disabled. CPU, PID, per-file, output, and time
limits also apply. `GOMEMLIMIT` is not the safety boundary. Each output stream
and JSON file is limited to 64 KiB. Builds and samples have the same deadline;
a cold build can fail within it. Check retained evidence before retrying.

Minimum free VM-local disk space is 1 GiB below 1,000 sources, 5 GiB from
1,000 sources, and 20 GiB at 10,000 sources. `minFreeGiB` can increase the guard.
Check disk and memory capacity before another full-scale sample.

Each job owns one container and volume. The runner saves bounded progress and
container state. It removes owned runtime data only after the container stops
and report export succeeds. If export fails, `job.json` records retained
resource names. Inspect those resources before explicit removal. Do not prune
unrelated Docker data. Local generated output remains until you remove it.

## Result Interpretation

Comparison rejects failed or OOM samples, mismatched source, toolchain, or runtime
configuration, nonsequential samples, wrong stored counts, and different
complete checksums. Validation is not skipped. Phase timings can overlap.

One pair is not a stable or causal performance estimate. Constrained VM results
do not prove native acceptance limits. The retained
[driver comparison](../benchmark/results/driver-2026-10-05.json) showed no
noticeable indexing gain. Databases, corpora, binaries, logs, and traces are
not retained in Git.