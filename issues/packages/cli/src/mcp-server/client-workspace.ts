import { fileURLToPath } from "node:url";

export type ClientWorkspaceRoot = {
	uri: string;
};

export type ClientWorkspaceCapabilities = {
	roots?: unknown;
};

export type McpWorkspaceScope = {
	projectIdentity?: string;
	workspaceRoot?: string;
};

export async function resolveClientWorkspaceRoot(
	listRoots: () => Promise<{ roots: readonly ClientWorkspaceRoot[] }>,
	capabilities: ClientWorkspaceCapabilities | undefined,
	fallback?: string
): Promise<string | undefined> {
	try {
		if (capabilities && !capabilities.roots) {
			return fallback;
		}

		const result = await listRoots();
		return selectWorkspaceRoot(result.roots) ?? fallback;
	} catch {
		return fallback;
	}
}

export async function resolveMcpWorkspaceScope(input: {
	listRoots: () => Promise<{ roots: readonly ClientWorkspaceRoot[] }>;
	capabilities: ClientWorkspaceCapabilities | undefined;
	fallbackWorkspaceRoot?: string;
	projectIdentity?: string;
	resolveIdentity?: (workspaceRoot: string) => string;
}): Promise<McpWorkspaceScope> {
	const workspaceRoot = await resolveClientWorkspaceRoot(input.listRoots, input.capabilities, input.fallbackWorkspaceRoot);
	const projectIdentity = input.projectIdentity ?? (workspaceRoot && input.resolveIdentity ? input.resolveIdentity(workspaceRoot) : undefined);
	return { projectIdentity, workspaceRoot };
}

export function selectWorkspaceRoot(roots: readonly ClientWorkspaceRoot[]): string | undefined {
	for (const root of roots) {
		const rootPath = fileRootPath(root.uri);
		if (rootPath) {
			return rootPath;
		}
	}

	return undefined;
}

export function fileRootPath(uri: string): string | undefined {
	try {
		const url = new URL(uri);
		if (url.protocol !== "file:") {
			return undefined;
		}

		return fileURLToPath(url);
	} catch {
		return undefined;
	}
}
