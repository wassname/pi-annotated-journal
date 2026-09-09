import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerExtension from "../index.ts";

test("records raw user messages and registers /annotate", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-annotate-extension-"));
	const previousJournal = process.env.PI_ANNOTATE_JOURNAL;
	process.env.PI_ANNOTATE_JOURNAL = join(directory, "human_journal.md");
	try {
		const commands = new Map<string, { description: string }>();
		const inputHandlers: Array<(event: { text: string; source: string }, ctx: unknown) => { action: string }> = [];
		const pi = {
			on(_event: string, handler: (event: { text: string; source: string }, ctx: unknown) => { action: string }) {
				inputHandlers.push(handler);
			},
			registerCommand(name: string, options: { description: string }) {
				commands.set(name, options);
			},
		};
		registerExtension(pi as never);

		const ctx = {
			cwd: directory,
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => join(directory, "session.jsonl"),
			},
		};
		assert.equal(inputHandlers.length, 1);
		assert.deepEqual(inputHandlers[0]({ text: "first line\nsecond line", source: "interactive" }, ctx), { action: "continue" });
		const journal = readFileSync(process.env.PI_ANNOTATE_JOURNAL, "utf8");
		assert.match(journal, /## .* · User message/);
		assert.match(journal, /> first line\n> second line/);
		assert.equal(commands.get("annotate")?.description, "Copy the last N user/assistant messages as Markdown quotes for annotation (default: 6)");
	} finally {
		if (previousJournal === undefined) delete process.env.PI_ANNOTATE_JOURNAL;
		else process.env.PI_ANNOTATE_JOURNAL = previousJournal;
		rmSync(directory, { recursive: true, force: true });
	}
});
