import { sql } from "drizzle-orm";

import type { ProspectorProjectSettings } from "@agent-issues/core";

import type { TenantExecutor } from "../../db/connection.js";

type ProjectSettingsRow = {
	prospector_settings: string;
};

export async function getProspectorSettings(executor: TenantExecutor): Promise<ProspectorProjectSettings> {
	const result = await executor.execute(sql`SELECT prospector_settings FROM project_settings
		WHERE tenant_id = ${executor.tenantId} AND project_id = ${executor.currentProjectId}::uuid`);
	const row = result.rows[0] as ProjectSettingsRow | undefined;
	return row === undefined ? {} : parseProspectorSettings(row.prospector_settings);
}

export async function setProspectorSettings(executor: TenantExecutor, settings: ProspectorProjectSettings): Promise<ProspectorProjectSettings> {
	const serializedSettings = JSON.stringify(normalizeProspectorSettings(settings));
	await executor.execute(sql`INSERT INTO project_settings (tenant_id, project_id, prospector_settings)
		VALUES (${executor.tenantId}, ${executor.currentProjectId}::uuid, ${serializedSettings})
		ON CONFLICT (tenant_id, project_id) DO UPDATE SET prospector_settings = EXCLUDED.prospector_settings`);
	return JSON.parse(serializedSettings) as ProspectorProjectSettings;
}

function parseProspectorSettings(value: string): ProspectorProjectSettings {
	try {
		return normalizeProspectorSettings(JSON.parse(value) as ProspectorProjectSettings);
	} catch {
		throw new Error("Stored Prospector settings are invalid.");
	}
}

function normalizeProspectorSettings(settings: ProspectorProjectSettings): ProspectorProjectSettings {
	return {
		...(settings.trunkBranches === undefined ? {} : { trunkBranches: [...settings.trunkBranches] }),
		...(settings.tagPrefix === undefined ? {} : { tagPrefix: settings.tagPrefix }),
		...(settings.enableCommitBumps === undefined ? {} : { enableCommitBumps: settings.enableCommitBumps }),
		...(settings.commitBumpPatterns === undefined ? {} : { commitBumpPatterns: { ...settings.commitBumpPatterns } }),
		...(settings.maxCommitScan === undefined ? {} : { maxCommitScan: settings.maxCommitScan })
	};
}