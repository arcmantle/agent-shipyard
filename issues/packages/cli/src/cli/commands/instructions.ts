import { Option } from "clipanion";
import { InstructionFragmentError, InstructionResetAllError, InstructionWriteError } from "@agent-issues/core";
import type { CommitInstructionChangesInput, PreviewInstructionInput, ResetInstructionAllInput } from "@agent-issues/core";
import { getInstructionVersion } from "../../runtime/instruction-version.js";
import { BodyTenantCommand, resolveMarkdownFileOption, TenantCommand, withStore } from "../shared.js";

export class RetrieveInstructionCommand extends TenantCommand {
	public static paths = [["instruction", "retrieve"]];
	public key = Option.String();

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const result = await store.retrieveInstruction({ key: this.key, version: getInstructionVersion() });
			if (this.asJson) this.print(result, result.body);
			else this.context.stdout.write(result.body);
			return 0;
		});
	}
}

export class PreviewInstructionCommand extends TenantCommand {
	public static paths = [["instruction", "preview"]];
	public key = Option.String();
	public inputFile = Option.String("--input-file", { required: true });

	public async execute(): Promise<number> {
		const text = await resolveMarkdownFileOption(this.inputFile, "--input-file");
		const input: Pick<PreviewInstructionInput, "changes"> = JSON.parse(text!);
		if (!input || !Array.isArray(input.changes)) throw new Error("Instruction input must contain a changes array.");
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const result = await store.previewInstruction({ key: this.key, version: getInstructionVersion(), changes: input.changes });
			if (this.asJson) this.print(result, result.body);
			else this.context.stdout.write(`Pending\n\n${result.body}`);
			return 0;
		});
	}
}

export class ListInstructionSourcesCommand extends TenantCommand {
	public static paths = [["instruction", "list"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const result = await store.listInstructionSources({ version: getInstructionVersion() });
			this.print(result, result.items.map((item) => `${item.key}\t${item.source.type}\trevision ${item.source.revision}`).join("\n"));
			return 0;
		});
	}
}

export class ReadInstructionSourceCommand extends TenantCommand {
	public static paths = [["instruction", "read"]];
	public key = Option.String();

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const result = await store.readInstructionSource({ key: this.key, version: getInstructionVersion() });
			if (this.asJson) this.print(result, result.body);
			else this.context.stdout.write(result.body);
			return 0;
		});
	}
}

export class CompareInstructionSourceCommand extends TenantCommand {
	public static paths = [["instruction", "compare"]];
	public key = Option.String();

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const result = await store.compareInstructionSource({ key: this.key, version: getInstructionVersion() });
			this.print(result, JSON.stringify(result, null, 2));
			return 0;
		});
	}
}

export class InspectInstructionDependenciesCommand extends TenantCommand {
	public static paths = [["instruction", "dependencies"]];
	public key = Option.String();

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const result = await store.inspectInstructionDependencies({ key: this.key, version: getInstructionVersion() });
			this.print(result, JSON.stringify(result, null, 2));
			return 0;
		});
	}
}

export class SaveInstructionSourceCommand extends BodyTenantCommand {
	public static paths = [["instruction", "save"]];
	public key = Option.String();
	public expectedRevision = Option.String("--expected-revision", { required: true });

	public async execute(): Promise<number> {
		const body = await this.resolveBody();
		if (body === undefined) throw new Error("--body-file is required for instruction save.");
		const expectedRevision = Number(this.expectedRevision);
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("--expected-revision must be a positive integer.");
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			try {
				const result = await store.saveInstructionSource({ key: this.key, version: getInstructionVersion(), body, expectedRevision });
				this.print(result, `Saved ${result.key} at revision ${result.source.revision}.`);
				return 0;
			} catch (error) {
				if (!(error instanceof InstructionWriteError)) throw error;
				if (!this.asJson) throw new InstructionWriteError(error.reason, error.currentSource,
					`${error.message}\nCurrent source: ${error.currentSource.key}, revision ${error.currentSource.source.revision}.`);
				this.print({ error: error.message, reason: error.reason, currentSource: error.currentSource }, error.message);
				return 1;
			}
		});
	}
}

export class ListInstructionHistoryCommand extends TenantCommand {
	public static paths = [["instruction", "history"]];
	public key = Option.String();

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const result = await store.listInstructionHistory({ key: this.key, version: getInstructionVersion() });
			this.print(result, result.revisions.map((item) => `${item.key}\trevision ${item.source.revision}\t${item.source.contentHash}`).join("\n"));
			return 0;
		});
	}
}

export class ReadInstructionRevisionCommand extends TenantCommand {
	public static paths = [["instruction", "revision"]];
	public key = Option.String();
	public revision = Option.String("--revision", { required: true });

	public async execute(): Promise<number> {
		const revision = Number(this.revision);
		if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("--revision must be a positive integer.");
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const result = await store.readInstructionRevision({ key: this.key, revision, version: getInstructionVersion() });
			if (this.asJson) this.print(result, result.body);
			else this.context.stdout.write(result.body);
			return 0;
		});
	}
}

export class RestoreInstructionRevisionCommand extends TenantCommand {
	public static paths = [["instruction", "restore"]];
	public key = Option.String();
	public revision = Option.String("--revision", { required: true });
	public expectedRevision = Option.String("--expected-revision", { required: true });

	public async execute(): Promise<number> {
		const revision = Number(this.revision);
		const expectedRevision = Number(this.expectedRevision);
		if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("--revision must be a positive integer.");
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("--expected-revision must be a positive integer.");
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			try {
				const result = await store.restoreInstructionRevision({ key: this.key, revision, expectedRevision, version: getInstructionVersion() });
				this.print(result, `Restored ${result.key} as revision ${result.source.revision}.`);
				return 0;
			} catch (error) {
				if (!(error instanceof InstructionWriteError) || !this.asJson) throw error;
				this.print({ error: error.message, reason: error.reason, currentSource: error.currentSource }, error.message);
				return 1;
			}
		});
	}
}

export class InspectInstructionResetCommand extends TenantCommand {
	public static paths = [["instruction", "reset-inspect"]];
	public key = Option.String();

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const impact = await store.inspectInstructionReset({ key: this.key, version: getInstructionVersion() });
			this.print(impact, JSON.stringify(impact, null, 2));
			return 0;
		});
	}
}

export class ResetInstructionSourceCommand extends TenantCommand {
	public static paths = [["instruction", "reset"]];
	public key = Option.String();
	public expectedRevision = Option.String("--expected-revision", { required: true });
	public confirmed = Option.Boolean("--yes", false);

	public async execute(): Promise<number> {
		if (!this.confirmed) throw new Error("Run instruction reset-inspect first. Use --yes to confirm the reset.");
		const expectedRevision = Number(this.expectedRevision);
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("--expected-revision must be a positive integer.");
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			try {
				const result = await store.resetInstructionSource({ key: this.key, expectedRevision, version: getInstructionVersion() });
				this.print(result, `Reset ${result.key} to the release default at revision ${result.source.revision}.`);
				return 0;
			} catch (error) {
				if (!(error instanceof InstructionWriteError) || !this.asJson) throw error;
				this.print({ error: error.message, reason: error.reason, currentSource: error.currentSource }, error.message);
				return 1;
			}
		});
	}
}

export class InspectInstructionResetAllCommand extends TenantCommand {
	public static paths = [["instruction", "reset-all-inspect"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const result = await store.inspectInstructionResetAll({ version: getInstructionVersion() });
			this.print(result, JSON.stringify(result, null, 2));
			return 0;
		});
	}
}

export class ResetInstructionAllCommand extends TenantCommand {
	public static paths = [["instruction", "reset-all"]];
	public inputFile = Option.String("--input-file", { required: true });
	public confirmed = Option.Boolean("--yes", false);

	public async execute(): Promise<number> {
		if (!this.confirmed) throw new Error("Run instruction reset-all-inspect first. Use --yes to confirm Reset All.");
		const text = await resolveMarkdownFileOption(this.inputFile, "--input-file");
		const input: Pick<ResetInstructionAllInput, "expectedRevisions"> = JSON.parse(text!);
		if (!input || !Array.isArray(input.expectedRevisions)) throw new Error("Instruction input must contain an expectedRevisions array.");
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			try {
				const result = await store.resetInstructionAll({ version: getInstructionVersion(), expectedRevisions: input.expectedRevisions });
				this.print(result, `Reset ${result.overrides.length} overrides and removed ${result.personalFragments.length} personal fragments.`);
				return 0;
			} catch (error) {
				if (!(error instanceof InstructionResetAllError) || !this.asJson) throw error;
				this.print({ error: error.message, reason: error.reason, currentInspection: error.currentInspection }, error.message);
				return 1;
			}
		});
	}
}

export class CommitInstructionChangesCommand extends TenantCommand {
	public static paths = [["instruction", "commit"]];
	public inputFile = Option.String("--input-file", { required: true });

	public async execute(): Promise<number> {
		const text = await resolveMarkdownFileOption(this.inputFile, "--input-file");
		const input: Pick<CommitInstructionChangesInput, "changes"> = JSON.parse(text!);
		if (!input || !Array.isArray(input.changes)) throw new Error("Instruction input must contain a changes array.");
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			try {
				const result = await store.commitInstructionChanges({ version: getInstructionVersion(), changes: input.changes });
				this.print(result, `Committed ${result.changes.length} instruction changes.`);
				return 0;
			} catch (error) {
				if (!(error instanceof InstructionWriteError) && !(error instanceof InstructionFragmentError)) throw error;
				if (!this.asJson) throw error;
				this.print({ error: error.message, reason: error.reason, currentSource: error.currentSource,
					...(error instanceof InstructionFragmentError ? { affectedReferences: error.affectedReferences } : {}) }, error.message);
				return 1;
			}
		});
	}
}

export class CreateInstructionFragmentCommand extends BodyTenantCommand {
	public static paths = [["instruction", "fragment", "create"]];
	public key = Option.String();

	public async execute(): Promise<number> {
		const body = await this.resolveBody();
		if (body === undefined) throw new Error("--body-file is required for fragment creation.");
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			try {
				const result = await store.createInstructionFragment({ key: this.key, version: getInstructionVersion(), body });
				this.print(result, `Created ${result.key} at revision ${result.source.revision}.`);
				return 0;
			} catch (error) {
				if (!(error instanceof InstructionFragmentError) || !this.asJson) throw error;
				this.print({ error: error.message, reason: error.reason, currentSource: error.currentSource, affectedReferences: error.affectedReferences }, error.message);
				return 1;
			}
		});
	}
}

export class RemoveInstructionFragmentCommand extends TenantCommand {
	public static paths = [["instruction", "fragment", "remove"]];
	public key = Option.String();
	public expectedRevision = Option.String("--expected-revision", { required: true });

	public async execute(): Promise<number> {
		const expectedRevision = Number(this.expectedRevision);
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("--expected-revision must be a positive integer.");
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			try {
				const result = await store.removeInstructionFragment({ key: this.key, version: getInstructionVersion(), expectedRevision });
				this.print(result, `Removed ${result.key} at revision ${result.source.revision}.`);
				return 0;
			} catch (error) {
				if (!(error instanceof InstructionFragmentError) || !this.asJson) throw error;
				this.print({ error: error.message, reason: error.reason, currentSource: error.currentSource, affectedReferences: error.affectedReferences }, error.message);
				return 1;
			}
		});
	}
}