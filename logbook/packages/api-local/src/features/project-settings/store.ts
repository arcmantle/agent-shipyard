import { sql } from "drizzle-orm";

import type { ProspectorProjectSettings } from "@agent-issues/core";

import type { SqliteExecutor } from "../../db/sqlite-executor.js";

type ProjectSettingsRow = {
	prospector_settings: string;
};

export function getProspectorSettings(executor: SqliteExecutor): ProspectorProjectSettings {
	const row = executor.drizzle.get(sql`SELECT prospector_settings FROM project_settings
		WHERE tenant_id = ${executor.tenantId} AND project_id = ${executor.currentProjectId}`) as ProjectSettingsRow | undefined;
	return row === undefined ? {} : parseProspectorSettings(row.prospector_settings);
}

export function setProspectorSettings(executor: SqliteExecutor, settings: ProspectorProjectSettings): ProspectorProjectSettings {
	const serializedSettings = JSON.stringify(normalizeProspectorSettings(settings));
	executor.drizzle.run(sql`INSERT INTO project_settings (tenant_id, project_id, prospector_settings)
		VALUES (${executor.tenantId}, ${executor.currentProjectId}, ${serializedSettings})
		ON CONFLICT (tenant_id, project_id) DO UPDATE SET prospector_settings = excluded.prospector_settings`);
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