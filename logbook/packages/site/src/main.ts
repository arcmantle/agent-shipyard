import "./agent-issues-app.js";

const root = document.querySelector("#app");

if (root) {
	root.replaceChildren(document.createElement("agent-issues-app"));
}
