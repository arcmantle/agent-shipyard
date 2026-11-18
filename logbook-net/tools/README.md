# Migration tools

## Test-vector exporter

`test-vectors.ts` runs the real TypeScript pure functions in `logbook/packages` with Bun. It writes exact inputs and expected outputs to `logbook-net/contract/test-vectors/`.

```sh
bun logbook-net/tools/test-vectors.ts          # write the vector files
bun logbook-net/tools/test-vectors.ts --check  # fail if the files differ from a fresh export
bun test logbook-net/tools                     # export, determinism, and mutation checks
```

Groups: `namespaces`, `stable-ids`, `references`, `content-hashes`, `reverse-patches`, `record-keys`, `project-identity`.

- Each vector has `name`, `behavior`, `input`, and `expected` (`{ "value": ... }` or `{ "error": "message" }`).
- Expected values are literal. Derivation outputs are never normalized.
- Binary data (reverse patches) is lower-case hex.
- The four stable-ID namespaces keep their `agent-issues/...` values. The export fails if the TypeScript source stops deriving from them.
- The project-identity vectors cover the legacy inputs only (environment variable, `.agent-issues.json`, `.agent-issues`, Git origin, package name, folder name). The new `.agent-shipyard` inputs have no TypeScript source to export.
- Project-identity vectors run the real resolver source. Only its two imports are supplied by the tool, so no database driver is installed.

Limits:
- Expected values come from the TypeScript source, so a comparison detects drift from that source, not a wrong original value. Only the four namespaces and the reference and short-reference literals of this tracker are checked independently.
- Random `generate*` functions, `mergeUserDirectories`, `deriveEntityKindFromId`, and `archiveHeadContentHash` have no vectors yet.
