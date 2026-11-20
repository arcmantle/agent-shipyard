import type { TemplateResult } from "lit";

export type ShowcaseCase = {
	description: string;
	id: string;
	label: string;
	render: () => TemplateResult;
	sectionLabel: string;
};