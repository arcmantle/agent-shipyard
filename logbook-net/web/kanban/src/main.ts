import "./styles/kanban-tokens.css";
import "./kanban-app.js";

const root = document.querySelector("#app");

root?.replaceChildren(document.createElement("kanban-app"));