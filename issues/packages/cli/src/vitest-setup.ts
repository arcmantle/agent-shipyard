// CLI integration tests exercise `openStorageDriver`'s local branch indirectly through
// `runCli`/`main`. Without this, every such test would try to spawn a real local daemon
// process (ISS190, ADR44), making the suite slow and non-deterministic. Tests that want to
// exercise daemon routing explicitly can delete this env var for the duration of the test.
process.env.VITEST = "true";
process.env.AGENT_ISSUES_NO_DAEMON = "1";
