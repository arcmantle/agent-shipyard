import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";

import { type PlanPreview, type PlanPreviewApp } from "./plan-preview-app.js";
import "./plan-preview-app.js";

const app = new App({ name: "Agent Issues Plan Preview", version: "1.0.0" }, {});
const element = document.querySelector("plan-preview-app") as PlanPreviewApp | null;

if (element) {
	element.openLink = async (url) => {
		const result = await app.openLink({ url });
		if (result.isError) {
			throw new Error("The host rejected the link.");
		}
	};
}

app.ontoolresult = ({ structuredContent }) => {
	const plan = (structuredContent as { plan?: PlanPreview } | undefined)?.plan;
	if (element && plan) {
		element.plan = plan;
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