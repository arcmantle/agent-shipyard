import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";

import { type IssuePreviewApp } from "./issue-preview-app.js";
import "./issue-preview-app.js";

const app = new App({ name: "Agent Issues Issue Preview", version: "1.0.0" }, {});
const element = document.querySelector("issue-preview-app") as IssuePreviewApp | null;

app.ontoolresult = ({ structuredContent }) => {
	const draft = (structuredContent as { draft?: IssuePreviewApp["draft"] } | undefined)?.draft;
	if (element && draft) {
		element.draft = draft;
		element.errorMessage = null;
	}
};

app.onhostcontextchanged = (context) => {
	if (context.theme) {
		applyDocumentTheme(context.theme);
	}
	if (context.styles?.variables) {
		applyHostStyleVariables(context.styles.variables);
	}
	if (context.styles?.css?.fonts) {
		applyHostFonts(context.styles.css.fonts);
	}
};

void app.connect().then(() => {
	const context = app.getHostContext();
	if (context) {
		app.onhostcontextchanged?.(context);
	}
});