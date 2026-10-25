import { runDatabaseSetup } from "./database-setup.js";

try {
	await runDatabaseSetup(process.env);
	process.stdout.write('{"event":"database-setup-complete"}\n');
} catch {
	process.stderr.write("Database setup failed. Approval, private access, identity mapping, or cleanup could not be verified.\n");
	process.exitCode = 1;
}