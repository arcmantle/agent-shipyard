export const MIGRATION_BENCHMARK = {
	sqlite: {
		fresh: { backups: 0, legacyTransforms: 0 },
		currentFinal: { backups: 0, legacyTransforms: 0 },
		legacyV7: { backups: 1, legacyTransforms: 1 }
	},
	postgres: {
		legacyV7: {
			fixtureCopies: [1, 2],
			statementCounts: [292, 292]
		}
	}
} as const;