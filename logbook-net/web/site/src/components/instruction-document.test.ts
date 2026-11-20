import { describe, expect, it } from "vitest";
import { InstructionDocument } from "./instruction-document.js";

describe("instruction Markdown editing", () => {
	it("keeps source frontmatter outside the editable body and preserves it after editing", async () => {
		const frontmatter = "---\r\nname: prepare\r\ndescription: 'Plugin metadata'\r\n---\r\n";
		const document = await InstructionDocument.load(`${frontmatter}# Original body\n`);
		expect(document.frontmatter).toBe(frontmatter);
		expect(JSON.stringify(document.editor.document)).not.toContain("Plugin metadata");
		document.editor.replaceBlocks(document.editor.document, [{ type: "paragraph", content: "Changed body" }]);
		const saved = await document.toMarkdown();
		expect(saved.startsWith(frontmatter)).toBe(true);
		const reloaded = await InstructionDocument.load(saved);
		expect(reloaded.frontmatter).toBe(frontmatter);
		expect(await reloaded.toMarkdown()).toContain("Changed body");
	});

	it("preserves repeated fragment targets and text order through Markdown conversion", async () => {
		const document = await InstructionDocument.load("Before <!-- include:fragment/rules --> after\n\n- Nested <!-- include:fragment/recipes/save -->\n\n<!-- include:fragment/rules -->");
		const references = document.editor.document.filter((block) => block.type === "fragmentReference");
		expect(references.map((block) => block.props.target)).toEqual(["fragment/rules", "fragment/recipes/save", "fragment/rules"]);
		document.editor.insertBlocks([{ type: "paragraph", content: "New text" }], document.editor.document[0], "before");
		const saved = await document.toMarkdown();
		expect(saved.match(/<!-- include:[^>]+ -->/g)).toEqual([
			"<!-- include:fragment/rules -->", "<!-- include:fragment/recipes/save -->", "<!-- include:fragment/rules -->"
		]);
		expect(saved.indexOf("Before")).toBeLessThan(saved.indexOf("include:fragment/rules"));
		expect(saved.indexOf("after")).toBeGreaterThan(saved.indexOf("include:fragment/rules"));
		const reloaded = await InstructionDocument.load(saved);
		expect((await reloaded.toMarkdown()).match(/<!-- include:[^>]+ -->/g)).toEqual(saved.match(/<!-- include:[^>]+ -->/g));
	});
});