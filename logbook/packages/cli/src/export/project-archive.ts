import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ArchiveReader, ArchiveReadResult } from "./project-archive-reader.js";
import { readProjectArchiveV1 } from "./project-archive-v1.js";

export { writeProjectArchiveV1 as writeProjectArchive } from "./project-archive-v1.js";
export type { ArchiveReadResult } from "./project-archive-reader.js";

const archiveHeaderSchema = z.object({
	format: z.literal("agent-logbook-project"),
	version: z.number().int().positive()
});

const readers: ReadonlyMap<number, ArchiveReader> = new Map([[1, readProjectArchiveV1]]);

export function readProjectArchive(inputPath: string): ArchiveReadResult {
	const root = realpathSync(inputPath);
	const readFile = (file: string) => {
		if (path.isAbsolute(file) || file.includes("\\") || file.split("/").some((part) => part === ".." || part === "" || part === ".")) throw new Error(`Invalid archive path: ${file}.`);
		const resolved = realpathSync(path.join(root, file));
		const relative = path.relative(root, resolved);
		if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error(`Archive path leaves the archive: ${file}.`);
		return readFileSync(resolved, "utf8");
	};
	const manifest: unknown = JSON.parse(readFile("manifest.json"));
	const header = archiveHeaderSchema.parse(manifest);
	const reader = readers.get(header.version);
	if (!reader) throw new Error(`Unsupported project archive version: ${header.version}. Supported versions: ${[...readers.keys()].join(", ")}.`);
	return reader({ manifest, readFile });
}
