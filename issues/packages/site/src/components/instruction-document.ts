import { BlockNoteEditor, BlockNoteSchema, createBlockSpec, defaultBlockSpecs, type PartialBlock } from "@blocknote/core";
import { splitInstructionMarkdown } from "@agent-issues/core/instruction-store";

const fragmentReference = createBlockSpec({
	type: "fragmentReference",
	propSchema: { target: { default: "" } },
	content: "none"
}, {
	render(block) {
		const dom = document.createElement("div");
		dom.className = "instruction-reference";
		dom.contentEditable = "false";
		dom.dataset.instructionFragment = block.props.target;
		const label = document.createElement("span");
		label.textContent = block.props.target.slice("fragment/".length);
		const open = document.createElement("button");
		open.type = "button";
		open.textContent = "Open";
		open.setAttribute("aria-label", `Open ${label.textContent}`);
		open.addEventListener("click", () => dom.dispatchEvent(new CustomEvent("instruction-fragment-open", {
			bubbles: true, composed: true, detail: { key: block.props.target }
		})));
		dom.append(label, open);
		return { dom };
	},
	toExternalHTML(block) {
		const dom = document.createElement("div");
		dom.dataset.instructionFragment = block.props.target;
		dom.textContent = `<!-- include:${block.props.target} -->`;
		return { dom };
	},
	parse(element) {
		const target = element.dataset.instructionFragment;
		return target ? { target } : undefined;
	}
});

const instructionSchema = BlockNoteSchema.create({ blockSpecs: { ...defaultBlockSpecs, fragmentReference: fragmentReference() } });
type InstructionEditor = typeof instructionSchema.BlockNoteEditor;
type InstructionBlock = PartialBlock<typeof instructionSchema.blockSchema, typeof instructionSchema.inlineContentSchema, typeof instructionSchema.styleSchema>;

export class InstructionDocument {
	public static async load(markdown: string) {
		const { frontmatter, body } = splitInstructionMarkdown(markdown);
		const editor = BlockNoteEditor.create({ schema: instructionSchema });
		const blocks: InstructionBlock[] = [];
		let offset = 0;
		for (const marker of body.matchAll(/<!--\s*include:([^\s]+)\s*-->/g)) {
			blocks.push(...await editor.tryParseMarkdownToBlocks(body.slice(offset, marker.index)));
			blocks.push({ type: "fragmentReference", props: { target: marker[1] } });
			offset = marker.index + marker[0].length;
		}
		blocks.push(...await editor.tryParseMarkdownToBlocks(body.slice(offset)));
		if (blocks.length) editor.replaceBlocks(editor.document, blocks);
		return new InstructionDocument(frontmatter, editor);
	}

	constructor(frontmatter: string, editor: InstructionEditor) {
		this.frontmatter = frontmatter;
		this.editor = editor;
	}

	public readonly frontmatter: string;
	public readonly editor: InstructionEditor;

	public async toMarkdown() {
		const references = new Map<string, string>();
		const tokenPrefix = `InstructionFragment${crypto.randomUUID().replaceAll("-", "")}`;
		const convert = (blocks: InstructionEditor["document"]): InstructionBlock[] => blocks.map((block) => {
			const children = convert(block.children);
			if (block.type !== "fragmentReference") return { ...block, children };
			const token = `${tokenPrefix}Reference${references.size}End`;
			references.set(token, `<!-- include:${block.props.target} -->`);
			return { type: "paragraph", content: token, children };
		});
		let body = await this.editor.blocksToMarkdownLossy(convert(this.editor.document));
		for (const [token, marker] of references) body = body.replaceAll(token, marker);
		return this.frontmatter + body;
	}
}