import { createHash, randomUUID } from "node:crypto";

type ConfirmationToken = {
	expiresAt: number;
	inputHash: string;
	toolName: string;
};

export class ConfirmationTokenStore {
	public constructor(now: () => number) {
		this.now = now;
	}

	protected readonly now: () => number;
	protected readonly tokens = new Map<string, ConfirmationToken>();

	public issue(toolName: string, input: Record<string, unknown>): { token: string; expiresAt: string } {
		const token = randomUUID();
		const expiresAt = this.now() + 5 * 60 * 1000;
		this.tokens.set(token, { toolName, inputHash: hashConfirmationInput(input), expiresAt });
		return { token, expiresAt: new Date(expiresAt).toISOString() };
	}

	public consume(token: string, toolName: string, input: Record<string, unknown>): void {
		const confirmation = this.tokens.get(token);
		this.tokens.delete(token);
		if (!confirmation) throw new Error("Invalid confirmation token.");
		if (confirmation.expiresAt <= this.now()) throw new Error("Confirmation token has expired.");
		if (confirmation.toolName !== toolName || confirmation.inputHash !== hashConfirmationInput(input)) {
			throw new Error("Confirmation token does not authorize this request.");
		}
	}
}

function hashConfirmationInput(input: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}