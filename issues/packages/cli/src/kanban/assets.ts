import { existsSync } from "node:fs";
import path from "node:path";

import { resolvePackagePath } from "../runtime/package-path.js";

const kanbanDistDir = resolvePackagePath("kanban", "dist");

export function ensureBuiltKanban(): string {
	const entrypoint = path.join(kanbanDistDir, "index.html");
	if (!existsSync(entrypoint)) {
		throw new Error("Kanban assets are not built. Run `pnpm run build` before serving the Kanban application.");
	}

	return kanbanDistDir;
}

export function getBuiltKanbanAssetPath(requestPath: string): string | null {
	const normalized = requestPath === "/" ? "/index.html" : requestPath;
	const cleaned = normalized.replace(/^\/+/, "");
	const root = ensureBuiltKanban();
	const candidate = path.resolve(root, cleaned);
	if (!candidate.startsWith(root)) {
		return null;
	}

	return existsSync(candidate) ? candidate : null;
}

export function getKanbanContentType(filePath: string): string {
	if (filePath.endsWith(".html")) {
		return "text/html; charset=utf-8";
	}

	if (filePath.endsWith(".js")) {
		return "text/javascript; charset=utf-8";
	}

	if (filePath.endsWith(".css")) {
		return "text/css; charset=utf-8";
	}

	if (filePath.endsWith(".svg")) {
		return "image/svg+xml";
	}

	return "application/octet-stream";
}