import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerExtension from "../index.ts";

test("records only long unquoted user input, notifies without injecting messages, and registers /annotate", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-annotate-extension-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	const previousJournal = process.env.PI_ANNOTATE_JOURNAL;
	process.env.PI_ANNOTATE_JOURNAL = join(directory, "human_journal.md");
	try {
		const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
		const inputHandlers: Array<(event: { text: string; source: string }, ctx: unknown) => { action: string }> = [];
		const pi = {
			on(_event: string, handler: (event: { text: string; source: string }, ctx: unknown) => { action: string }) {
				inputHandlers.push(handler);
			},
			registerCommand(name: string, options: { description: string; handler: (args: string, ctx: any) => Promise<void> }) {
				commands.set(name, options);
			},
		};
		registerExtension(pi as never);

		const notifications: string[] = [];
		const ctx = {
			cwd: directory,
			hasUI: true,
			ui: { notify: (message: string) => notifications.push(message) },
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => join(directory, "session.jsonl"),
			},
		};
		assert.equal(inputHandlers.length, 1);
		for (const text of ["", "ok", "first\nsecond", "first\n\n \nsecond\n", "> first\n> second\n> third", "first\n> quote\n  > indented quote\nsecond"]) {
			assert.deepEqual(inputHandlers[0]({ text, source: "interactive" }, ctx), { action: "continue" });
		}
		assert.deepEqual(inputHandlers[0]({ text: "first\nsecond\nthird", source: "extension" }, ctx), { action: "continue" });
		assert.equal(existsSync(process.env.PI_ANNOTATE_JOURNAL), false);
		assert.deepEqual(notifications, []);
		inputHandlers[0]({ text: "default\noff\nplease", source: "interactive" }, ctx);
		assert.equal(existsSync(process.env.PI_ANNOTATE_JOURNAL), false);
		assert.deepEqual(notifications, []);
		await commands.get("annotate-settings")!.handler("auto on", ctx);
		notifications.length = 0;
		assert.deepEqual(inputHandlers[0]({ text: "first line\r\nsecond line\r\n> quote\r\nthird line", source: "interactive" }, ctx), { action: "continue" });
		const journal = readFileSync(process.env.PI_ANNOTATE_JOURNAL, "utf8");
		assert.match(journal, /## .* · User message/);
		assert.match(journal, /> first line\n> second line\n> > quote\n> third line/);
		assert.deepEqual(notifications, [`long user message appended to ${process.env.PI_ANNOTATE_JOURNAL}`]);
		assert.doesNotMatch(journal, /long user message appended/);
		assert.deepEqual(inputHandlers[0]({ text: "rpc first\nrpc second\nrpc third\nrpc fourth", source: "rpc" }, { ...ctx, hasUI: false }), { action: "continue" });
		assert.match(readFileSync(process.env.PI_ANNOTATE_JOURNAL, "utf8"), /> rpc fourth/);
		assert.equal(notifications.length, 1);
		assert.equal(commands.get("annotate")?.description, "Copy the last N user/assistant messages as Markdown quotes for annotation (default: 6)");
		const command = commands.get("annotate-settings")!;
		await command.handler("auto off", ctx);
		const before = readFileSync(process.env.PI_ANNOTATE_JOURNAL, "utf8");
		registerExtension(pi as never); // Reload still reads the saved preference.
		inputHandlers.at(-1)!({ text: "not\nsaved\nnow", source: "interactive" }, ctx);
		assert.equal(readFileSync(process.env.PI_ANNOTATE_JOURNAL, "utf8"), before);
		await command.handler("", { ...ctx, ui: { ...ctx.ui, select: async () => undefined } });
		assert.equal(JSON.parse(readFileSync(join(directory, "annotate.json"), "utf8")).autoAnnotate, false);
		await command.handler("", { ...ctx, ui: { ...ctx.ui, select: async () => "auto on" } });
		inputHandlers.at(-1)!({ text: "saved\nagain\nnow", source: "interactive" }, ctx);
		assert.match(readFileSync(process.env.PI_ANNOTATE_JOURNAL, "utf8"), /> saved\n> again\n> now/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousJournal === undefined) delete process.env.PI_ANNOTATE_JOURNAL;
		else process.env.PI_ANNOTATE_JOURNAL = previousJournal;
		rmSync(directory, { recursive: true, force: true });
	}
});
