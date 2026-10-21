import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BUILD_INFO_FILENAME = "build-info.json";

declare const __AGENT_ISSUES_BUNDLED__: boolean | undefined;

/**
 * The daemon's version identity (ADR45): a content hash of every file under
 * `distDir`, excluding `build-info.json` itself (writing that file must not
 * change the hash it records). Deterministic regardless of directory-listing
 * order, since file paths are sorted before hashing.
 */
export function computeBuildContentHash(distDir: string): string {
	const relativeFilePaths: string[] = [];

	function walk(currentDir: string, relativeDir: string): void {
		for (const entry of readdirSync(currentDir)) {
			const absolutePath = path.join(currentDir, entry);
			const relativePath = path.join(relativeDir, entry);
			if (statSync(absolutePath).isDirectory()) {
				walk(absolutePath, relativePath);
			} else if (entry !== BUILD_INFO_FILENAME) {
				relativeFilePaths.push(relativePath);
			}
		}
	}
	walk(distDir, "");
	relativeFilePaths.sort();

	const hash = createHash("sha256");
	for (const relativePath of relativeFilePaths) {
		hash.update(relativePath);
		hash.update(readFileSync(path.join(distDir, relativePath)));
	}
	return hash.digest("hex");
}

/** Emits `distDir/build-info.json` carrying `distDir`'s current build-content-hash. Run once as a build postbuild step. */
export function writeBuildInfoFile(distDir: string): void {
	const buildHash = computeBuildContentHash(distDir);
	writeFileSync(path.join(distDir, BUILD_INFO_FILENAME), `${JSON.stringify({ buildHash }, null, 2)}\n`, "utf8");
}

export type ReadBuildContentHashOptions = {
	/** Overrides where `build-info.json` is read from; defaults to the package's `dist/` root (i.e. two directories up from this compiled module, which lives at `dist/daemon/build-info.js` for a real install). */
	distDir?: string;
};

/**
 * Reads this install's build-content-hash, or `"dev"` when no
 * `build-info.json` exists yet - e.g. running straight from `src/` (tests,
 * local `ts` execution) rather than a real build. Two "dev" instances
 * always compare equal, so the version handshake never fires spuriously
 * outside of an actual built install.
 */
export function readBuildContentHash(options?: ReadBuildContentHashOptions): string {
	const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
	const defaultDistDir = typeof __AGENT_ISSUES_BUNDLED__ === "undefined" ? path.dirname(moduleDirectory) : moduleDirectory;
	const distDir = options?.distDir ?? defaultDistDir;
	const filePath = path.join(distDir, BUILD_INFO_FILENAME);
	if (!existsSync(filePath)) return "dev";

	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		const buildHash = (parsed as { buildHash?: unknown } | null)?.buildHash;
		return typeof buildHash === "string" ? buildHash : "dev";
	} catch {
		return "dev";
	}
}
