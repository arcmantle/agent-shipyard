import "./agent-issues-app.js";
import { startHostedSession } from "./services/hosted-session.js";

const root = document.querySelector("#app");

if (root) {
	await startHostedSession();
	root.replaceChildren(document.createElement("agent-issues-app"));
}
