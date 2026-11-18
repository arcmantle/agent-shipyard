# Contract extractor

Extracts the command and interface inventory of the TypeScript Logbook. The result is `logbook-net/contract/inventory.json`. A missing contract case is found by comparing cases against this inventory.

## Run

Prerequisites: Bun, and in `logbook/` run `pnpm install` and build the workspace packages that the CLI imports:
`pnpm --filter @agent-issues/core build`, `pnpm --filter @agent-issues/api-local build`, `pnpm --filter @agent-issues/api-pg build`.

```sh
cd logbook-net/tools/contract-extractor
bun run extract   # write ../../contract/inventory.json
bun run check     # fail if the committed file is out of date
bun test
```

## What the inventory holds

| Section | Source | How |
| --- | --- | --- |
| `cli.commands` | Clipanion command classes registered by `command-loader.ts` | Loaded at run time. Options, arguments and rest arguments come from the Clipanion option specs. |
| `capabilities` | `getCapabilitiesPayload()` | Loaded at run time. `inCapabilities` marks the paths that `capabilities` lists. |
| `rpc` | `rpcMethods` and `writeMethods` in `rpc-methods.ts` | Loaded at run time. `owner` is the feature store interface that declares the method. |
| `mcp` | `mcp-server/index.ts` | Source scan: tools, tool order (the tool list), both UI resources. |
| `website`, `hostRoutes` | `site-routes.ts`, `site/server.ts`, `create-json-rpc-app.ts`, `api-pg/src/index.ts` | Source scan of route registrations. |
| `storageContract` | `storage-driver-contract.ts` | Source scan of the contract suite group names. |

Each CLI item carries `family` and `source` (the owning file), and each RPC method carries `owner`, so that a Port slice selects its own surfaces.

Each CLI path has these case requirements: `help` and `error` (exit code and stderr) always; `jsonSuccess` when the command has `--json`; `humanOutput` when the command writes text.

## Detecting change

The output has no timestamps, absolute paths or unordered data. Unchanged source gives equal output. A command, option, RPC method, MCP tool, UI resource or route change gives a different file, and `bun run check` fails. A new command family that the extractor does not know, or a command listed by `capabilities` that is not registered, stops the extraction with an error.
