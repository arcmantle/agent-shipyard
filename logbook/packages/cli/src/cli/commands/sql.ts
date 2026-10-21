import { ensureDatabase, querySqlite } from "@agent-issues/api-local";
import { Option } from "clipanion";

import { getActiveSavedLogin } from "../../auth/auth-session.js";
import { requirePositional, TenantCommand } from "../shared.js";

export class SqlCommand extends TenantCommand {
	public static paths = [["sql"]];

	public positionals = Option.Rest();

	public async execute(): Promise<number> {
		const activeLogin = await getActiveSavedLogin(this.context.credentialStoreOptions);
		if (activeLogin.kind !== "local") {
			throw new Error("Direct SQL is available only when the active saved login is local. Run \"agent-issues auth switch local\" first.");
		}

		const statement = requirePositional(this.positionals, 0, "sql <statement>");
		const { db, dbPath } = await ensureDatabase(this.dbPath, this.withStoreOptions());
		db.close();
		const rows = querySqlite(dbPath, statement);
		this.print({ rows }, JSON.stringify(rows, null, 2));
		return 0;
	}
}