import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";

export interface RuntimeAccessBoundaryViolation {
	file: string;
	line: number;
	driver: "pg" | "better-sqlite3";
	method:
		| "query"
		| "prepare"
		| "exec"
		| "transaction"
		| "pragma"
		| "all"
		| "get"
		| "run"
		| "import"
		| "construct"
		| "db"
		| "identityToken"
		| "$client";
}

const allowedMethodInfrastructure = new Set([
	"api-pg/src/db/connection.ts",
	"api-pg/src/db/migration-runner.ts",
	"api-pg/src/db/source-profile.ts",
	"api-pg/src/db/tenant-admin.ts",
	"api-pg/src/db/test-tenant-cleanup.ts"
]);
const SQLITE_ADAPTER_MODULE = "api-local/src/db/sqlite-connection.ts";
const SQLITE_RAW_METHODS = new Set(["prepare", "exec", "transaction", "pragma", "all", "get", "run"]);
const SQLITE_ESCAPE_HATCH_PROPERTIES = new Set(["db", "identityToken"]);
const SQLITE_DRIVER_OBJECT_NAMES = new Set(["db", "database", "connection", "executor", "sqlite"]);

function isAllowedMethodInfrastructure(file: string): boolean {
	return allowedMethodInfrastructure.has(file) || file.startsWith("api-local/src/migrations/") || file.startsWith("api-pg/src/migrations/");
}

function visitAst(value: unknown, visit: (node: Record<string, unknown>) => void): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			visitAst(item, visit);
		}
		return;
	}
	if (!value || typeof value !== "object") {
		return;
	}

	const node = value as Record<string, unknown>;
	if (typeof node.type === "string") {
		visit(node);
	}
	for (const [key, child] of Object.entries(node)) {
		if (key !== "loc" && key !== "start" && key !== "end") {
			visitAst(child, visit);
		}
	}
}

function listTypeScriptFiles(root: string): string[] {
	const files: string[] = [];

	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const entryPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...listTypeScriptFiles(entryPath));
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			files.push(entryPath);
		}
	}

	return files;
}

export function findRuntimeAccessBoundaryViolations(root: string): RuntimeAccessBoundaryViolation[] {
	const violations: RuntimeAccessBoundaryViolation[] = [];

	for (const filePath of listTypeScriptFiles(root)) {
		const relativeFile = path.relative(root, filePath).split(path.sep).join("/").replace(/^packages\//, "");
		if (!relativeFile.startsWith("api-pg/src/") && !relativeFile.startsWith("api-local/src/")) {
			continue;
		}

		const driver = relativeFile.startsWith("api-pg/") ? "pg" : "better-sqlite3";
		if (driver === "pg" && isAllowedMethodInfrastructure(relativeFile)) {
			continue;
		}

		let ast: ReturnType<typeof parse>;
		try {
			ast = parse(readFileSync(filePath, "utf8"), { sourceType: "module", plugins: ["typescript"] });
		} catch {
			continue;
		}
		const sqliteImportNames = new Set<string>();
		const sourceProgram = ast.program as { body?: unknown[] };

		for (const statement of sourceProgram.body ?? []) {
			const node = statement as Record<string, unknown>;
			if (node.type !== "ImportDeclaration") {
				continue;
			}
			const source = node.source as Record<string, unknown> | undefined;
			if (source?.type !== "StringLiteral" || source.value !== "better-sqlite3") {
				continue;
			}
			const loc = node.loc as { start?: { line?: number } } | undefined;
			const specifiers = (node.specifiers as Array<Record<string, unknown>> | undefined) ?? [];
			for (const specifier of specifiers) {
				const local = specifier.local as Record<string, unknown> | undefined;
				if (local?.type === "Identifier" && typeof local.name === "string") {
					sqliteImportNames.add(local.name);
				}
			}
			if (relativeFile !== SQLITE_ADAPTER_MODULE) {
				violations.push({
					file: relativeFile,
					line: loc?.start?.line ?? 1,
					driver: "better-sqlite3",
					method: "import"
				});
			}
		}

		const checkMethodCalls = !isAllowedMethodInfrastructure(relativeFile);
		const checkSqliteNativeAccess = driver === "better-sqlite3";

		visitAst(ast, (node) => {
			if (node.type === "MemberExpression" && !node.computed) {
				const property = node.property as Record<string, unknown> | undefined;
				const loc = node.loc as { start?: { line?: number } } | undefined;
				if (
					relativeFile !== SQLITE_ADAPTER_MODULE
					&& property?.type === "Identifier"
					&& property.name === "$client"
				) {
					violations.push({
						file: relativeFile,
						line: loc?.start?.line ?? 1,
						driver: "better-sqlite3",
						method: "$client"
					});
				}
			}

			if (checkSqliteNativeAccess && node.type === "NewExpression") {
				const callee = node.callee as Record<string, unknown> | undefined;
				const loc = node.loc as { start?: { line?: number } } | undefined;
				if (callee?.type === "Identifier" && typeof callee.name === "string" && sqliteImportNames.has(callee.name)) {
					if (relativeFile !== SQLITE_ADAPTER_MODULE) {
						violations.push({
							file: relativeFile,
							line: loc?.start?.line ?? 1,
							driver: "better-sqlite3",
							method: "construct"
						});
					}
				}
			}

			if (checkSqliteNativeAccess && node.type === "MemberExpression" && !node.computed) {
				const object = node.object as Record<string, unknown> | undefined;
				const property = node.property as Record<string, unknown> | undefined;
				const loc = node.loc as { start?: { line?: number } } | undefined;
				const objectIdentifier = object?.type === "Identifier" && typeof object.name === "string" ? object.name : undefined;
				if (
					objectIdentifier !== undefined
					&& SQLITE_DRIVER_OBJECT_NAMES.has(objectIdentifier)
					&& property?.type === "Identifier"
					&& typeof property.name === "string"
					&& SQLITE_ESCAPE_HATCH_PROPERTIES.has(property.name)
				) {
					violations.push({
						file: relativeFile,
						line: loc?.start?.line ?? 1,
						driver: "better-sqlite3",
						method: property.name as RuntimeAccessBoundaryViolation["method"]
					});
				}
			}

			if (!checkMethodCalls) {
				return;
			}

			const callee = node.callee as Record<string, unknown> | undefined;
			const property = callee?.property as Record<string, unknown> | undefined;
			const object = callee?.object as Record<string, unknown> | undefined;
			const method = node.type === "CallExpression" && callee?.type === "MemberExpression" && !callee.computed && property?.type === "Identifier"
				? property.name
				: undefined;
			const objectIdentifier = object?.type === "Identifier" && typeof object.name === "string" ? object.name : undefined;
			const isThisDbCall = object?.type === "MemberExpression"
				&& object.object && (object.object as Record<string, unknown>).type === "ThisExpression"
				&& (object.property as Record<string, unknown>)?.type === "Identifier"
				&& (object.property as Record<string, unknown>).name === "db";
			const isDrizzleCall = object?.type === "MemberExpression"
				&& (object.property as Record<string, unknown>)?.type === "Identifier"
				&& (object.property as Record<string, unknown>).name === "drizzle";
			const isLikelySqliteDriverCall = (objectIdentifier !== undefined && SQLITE_DRIVER_OBJECT_NAMES.has(objectIdentifier)) || isThisDbCall;
			if (
				(driver === "pg" && method === "query") ||
				(driver === "better-sqlite3"
					&& typeof method === "string"
					&& SQLITE_RAW_METHODS.has(method)
					&& isLikelySqliteDriverCall
					&& !isDrizzleCall)
			) {
				const loc = node.loc as { start?: { line?: number } } | undefined;
				violations.push({
					file: relativeFile,
					line: loc?.start?.line ?? 1,
					driver,
					method: method as RuntimeAccessBoundaryViolation["method"]
				});
			}
		});
	}

	return violations;
}