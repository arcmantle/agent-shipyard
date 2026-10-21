import type { ProspectorProjectSettings } from "../project-settings/prospector-settings.js";

export interface ProjectSettingsStore {
	getProspectorSettings(): Promise<ProspectorProjectSettings>;
	setProspectorSettings(settings: ProspectorProjectSettings): Promise<ProspectorProjectSettings>;
}