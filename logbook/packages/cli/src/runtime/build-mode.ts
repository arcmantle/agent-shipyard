declare const __AGENT_ISSUES_BUILD_MODE__: "development" | "production" | undefined;

export const BUILD_MODE: "development" | "production" =
	typeof __AGENT_ISSUES_BUILD_MODE__ === "undefined" ? "development" : __AGENT_ISSUES_BUILD_MODE__;
