import type { Migration } from "@agent-issues/core";
import { adrStatusMigration } from "./adr-status-migration.js";
import { finalBaselineMigration } from "./final-baseline.js";
import { userDirectoryMigration } from "./user-directory.js";
import { recordProvenanceMigration } from "./record-provenance.js";
import { contextTermProvenanceMigration } from "./context-term-provenance.js";
import { relationProvenanceMigration } from "./relation-provenance.js";
import { issueCommentsMigration } from "./issue-comments.js";
import { debtMetadataMigration } from "./debt-metadata.js";
import { entityTypeMigration } from "./entity-type.js";
import { shortEntityReferenceMigration } from "./short-entity-reference.js";
import { shortRecordReferenceMigration } from "./short-record-reference.js";
import { planEntriesMigration } from "./plan-entries.js";
import { planEntrySupersessionPositionMigration } from "./plan-entry-supersession-position.js";
import { entitySearchMigration } from "./entity-search.js";
import { recordSearchMigration } from "./record-search.js";
import { tokenSearchMigration } from "./token-search.js";
import { trigramSearchMigration } from "./trigram-search.js";
import { searchTypoVocabularyMigration } from "./search-typo-vocabulary.js";
import { pioneerEntityTypesMigration } from "./pioneer-entity-types.js";
import { issueBreakdownDraftsMigration } from "./issue-breakdown-drafts.js";
import { projectSettingsMigration } from "./project-settings.js";
import { completionObservationsMigration } from "./completion-observations.js";
import { completionObservationVersionStateMigration } from "./completion-observation-version-state.js";
import { instructionDefaultsMigration } from "./instruction-defaults.js";
import { instructionOverridesMigration } from "./instruction-overrides.js";
import { instructionPersonalFragmentsMigration } from "./instruction-personal-fragments.js";
import { instructionHistoryMigration } from "./instruction-history.js";
import { instructionResetsMigration } from "./instruction-resets.js";

/**
 * Approved runner migrations for an empty SQLite source profile. Legacy v7
 * sources use the direct transformer and do not replay historical migrations.
 */
export const migrations: Migration[] = [finalBaselineMigration, adrStatusMigration, userDirectoryMigration, recordProvenanceMigration, contextTermProvenanceMigration, relationProvenanceMigration, issueCommentsMigration, debtMetadataMigration, entityTypeMigration, shortEntityReferenceMigration, shortRecordReferenceMigration, planEntriesMigration, planEntrySupersessionPositionMigration, entitySearchMigration, recordSearchMigration, tokenSearchMigration, trigramSearchMigration, searchTypoVocabularyMigration, pioneerEntityTypesMigration, issueBreakdownDraftsMigration, projectSettingsMigration, completionObservationsMigration, completionObservationVersionStateMigration, instructionDefaultsMigration, instructionOverridesMigration, instructionPersonalFragmentsMigration, instructionHistoryMigration, instructionResetsMigration];
