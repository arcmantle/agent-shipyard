import type { MigrationBundle } from "@agent-issues/core";

export interface ArchiveManifest {
	format: "agent-logbook-project";
	version: number;
	projectId: string;
	generatedAt: string;
	instructionsIncluded: boolean;
	documents: Array<{
		section: "entities" | "contexts" | "contextTerms" | "issueComments" | "planEntries";
		id: string;
		file: string;
		originalFile: string;
	}>;
}

export interface ArchiveReadResult {
	bundle: MigrationBundle;
	manifest: ArchiveManifest;
	editedReferences: string[];
}

export type ArchiveReader = (input: {
	manifest: unknown;
	readFile: (file: string) => string;
}) => ArchiveReadResult;
