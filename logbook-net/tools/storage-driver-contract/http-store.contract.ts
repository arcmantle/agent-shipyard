// Runs the shared TypeScript storage-driver contract through the TypeScript HttpStore against a running .NET API host.
// `run.ts` starts it and selects the tests of the ported slices; nothing else in the contract applies to the .NET API yet.
import { randomUUID } from "node:crypto";
import { HttpStore } from "../../../logbook/packages/core/dist/index.js";
import { runStorageDriverContractSuite } from "../../../logbook/packages/core/dist/features/storage-driver/storage-driver-contract.js";

const baseUrl = process.env.AGENT_LOGBOOK_API_URL;
if (!baseUrl) throw new Error("AGENT_LOGBOOK_API_URL must name the .NET API host. Start it with run.ts.");

// The Local API host has one tenant, so a store gets its own project instead: the contract opens many independent stores.
// A project identity that the contract names (openStoreForProject) is kept, so two stores of one test share the project.
const runId = randomUUID().slice(0, 8);
const open = (projectIdentity: string) => new HttpStore({ baseUrl, tenantId: "local", bearerToken: "contract", projectIdentity });

runStorageDriverContractSuite({
	label: "HttpStore over the .NET API host",
	openStore: () => open(`contract-${runId}-${randomUUID()}`),
	openStoreForProject: (projectIdentity: string) => open(`${projectIdentity}-${runId}`)
});
