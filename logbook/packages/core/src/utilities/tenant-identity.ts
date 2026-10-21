import { userInfo } from "node:os";

/**
 * Normalizes an arbitrary string into a filesystem/tenant-id-safe segment
 * (lowercase, hyphen-separated, no leading/trailing/duplicate hyphens).
 * Lives here (not database.ts) so both `database.ts` and the migration
 * modules under `migrations/*.ts` can import it without a cycle - migration
 * modules must never import `database.ts`, which itself imports the
 * migrations.
 */
export function sanitizePathSegment(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
}

function resolveOsUsername(): string {
	try {
		return userInfo().username;
	} catch {
		return process.env.USER ?? process.env.USERNAME ?? "user";
	}
}

export function resolveLocalUsername(): string {
	return resolveOsUsername();
}

/**
 * The shared, well-known local tenant (ISS63, correcting ADR7/ISS34's
 * incomplete migration of ADR7's decision). Every workspace on this machine
 * defaults into this ONE user-scoped tenant instead of minting its own
 * tenant per folder; each previously-independent workspace becomes a
 * `project` entity under it. Scoped per OS user, not global, so multiple
 * accounts sharing a machine never collide.
 *
 * Lives here rather than `database.ts` (ISS181) so
 * `migrations/0008-consolidate-legacy-tenants-backfill.ts` - the one-time,
 * ledgered migration that folds every pre-existing legacy tenant into a
 * project under this tenant - can compute its own sweep target directly,
 * without needing `database.ts` to pass it in as a parameter (which would
 * only be possible for the CALLER's own current tenant, not for the fixed,
 * static migration array itself).
 */
export function resolveWellKnownLocalTenantId(): string {
	const sanitizedUsername = sanitizePathSegment(resolveLocalUsername()) || "user";
	return `local-${sanitizedUsername}`;
}
