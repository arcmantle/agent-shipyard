import { createHash } from "node:crypto";
import { normalizeInstructionBundle, type InstructionBundle } from "@agent-issues/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

function hash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export async function installInstructionBundle(pool: Pool, bundle: InstructionBundle): Promise<void> {
	const { items } = normalizeInstructionBundle(bundle);
	const contentHash = hash(JSON.stringify(items));
	await drizzle(pool).transaction(async (executor) => {
		await executor.execute(sql`LOCK TABLE instruction_bundles IN EXCLUSIVE MODE`);
		const existing = await executor.execute<{ content_hash: string }>(sql`SELECT content_hash FROM instruction_bundles WHERE version = ${bundle.version}`);
		if (existing.rows.length) {
			if (existing.rows[0].content_hash !== contentHash) throw new Error(`Instruction bundle is immutable: ${bundle.version}`);
		} else {
			await executor.execute(sql`INSERT INTO instruction_bundles (version, content_hash) VALUES (${bundle.version}, ${contentHash})`);
			for (const item of items) {
				await executor.execute(sql`INSERT INTO instruction_defaults (version, item_key, kind, body, revision, content_hash)
					VALUES (${bundle.version}, ${item.key}, ${item.kind}, ${item.body}, 1, ${hash(item.body)})`);
			}
		}
	});
}