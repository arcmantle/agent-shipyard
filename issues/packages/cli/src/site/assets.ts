import { cpSync, existsSync } from "node:fs";
import path from "node:path";

import { resolvePackagePath } from "../runtime/package-path.js";

const siteDistDir = resolvePackagePath("site", "dist");

export function ensureBuiltSite(): string {
	const entrypoint = path.join(siteDistDir, "index.html");
	if (!existsSync(entrypoint)) {
		throw new Error("Site assets are not built. Run `pnpm run build` before serving or exporting the site.");
	}

	return siteDistDir;
}

export function copyBuiltSite(outputDir: string) {
	cpSync(ensureBuiltSite(), outputDir, { force: true, recursive: true });
}

export function getBuiltSiteAssetPath(requestPath: string): string | null {
	const normalized = requestPath === "/" ? "/index.html" : requestPath;
	const cleaned = normalized.replace(/^\/+/, "");
	const root = ensureBuiltSite();
	const candidate = path.resolve(root, cleaned);
	if (!candidate.startsWith(root)) {
		return null;
	}

	return existsSync(candidate) ? candidate : null;
}

export function getContentType(filePath: string): string {
	if (filePath.endsWith(".html")) {
		return "text/html; charset=utf-8";
	}

	if (filePath.endsWith(".js")) {
		return "text/javascript; charset=utf-8";
	}

	if (filePath.endsWith(".css")) {
		return "text/css; charset=utf-8";
	}

	if (filePath.endsWith(".json")) {
		return "application/json; charset=utf-8";
	}

	if (filePath.endsWith(".svg")) {
		return "image/svg+xml";
	}

	if (filePath.endsWith(".ico")) {
		return "image/x-icon";
	}

	return "application/octet-stream";
}