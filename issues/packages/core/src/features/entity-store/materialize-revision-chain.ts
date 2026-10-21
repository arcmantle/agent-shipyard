export type RevisionPatchMetadata = {
	revision: number;
	author: string;
	createdAt: string;
};

export type MaterializedRevisionState<State> = {
	state: State;
	author: string;
	createdAt: string;
};

export function materializeRevisionChain<State, Patch extends RevisionPatchMetadata>(input: {
	recordLabel: string;
	headState: State;
	headRevision: number;
	headCreatedAt: string;
	patches: Patch[];
	targetRevision: number;
	applyReversePatch: (state: State, patch: Patch) => State;
	createError: (message: string, headRevision: number) => Error;
}): MaterializedRevisionState<State> {
	const { recordLabel, headRevision, targetRevision } = input;
	if (targetRevision < 1) {
		throw input.createError(`Revision ${targetRevision} is out of range for ${recordLabel}: revision must be >= 1.`, headRevision);
	}
	if (targetRevision > headRevision) {
		throw input.createError(`Revision ${targetRevision} is out of range for ${recordLabel}: head is at revision ${headRevision}.`, headRevision);
	}

	const patchByRevision = new Map<number, Patch>(input.patches.map((patch) => [patch.revision, patch]));
	let state = input.headState;
	for (let revision = headRevision; revision > targetRevision; revision--) {
		const patch = patchByRevision.get(revision);
		if (!patch) {
			throw input.createError(`Broken delta chain for ${recordLabel}: delta for revision ${revision} is missing.`, headRevision);
		}
		state = input.applyReversePatch(state, patch);
	}

	const targetPatch = patchByRevision.get(targetRevision);
	if (targetRevision > 1 && !targetPatch) {
		throw input.createError(`Broken delta chain for ${recordLabel}: delta for revision ${targetRevision} is missing.`, headRevision);
	}

	return {
		state,
		author: targetPatch?.author ?? "system",
		createdAt: targetPatch?.createdAt ?? input.headCreatedAt
	};
}