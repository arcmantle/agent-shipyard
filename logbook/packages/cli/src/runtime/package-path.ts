import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function resolvePackagePath(...segments: string[]): string {
	return path.join(packageRoot, ...segments);
}