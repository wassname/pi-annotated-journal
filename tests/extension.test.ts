import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerExtension from "../index.ts";

test("/annotate journals feedback and sends hidden model context", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-annotate-extension-"));
	const previousJournal = process.env.PI_ANNOTATE_JOURNAL;
	process.env.PI_ANNOTATE_JOURNAL = join(directory, "human_journal.md");
	try {
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const sent: Array<{ message: { customType: string; content: string; display: boolean }; options: { triggerTurn: boolean } }> = [];
		const entries: Array<{ type: string; data: unknown }> = [];
		const inputHandlers: Array<(event: { text: string; source: string }, ctx: unknown) => { action: string }> = [];
		const pi = {
			on(_event: string, handler: (event: { text: string; source: string }, ctx: unknown) => { action: string }) {
				inputHandlers.push(handler);
			},
			registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, options);
			},
			appendEntry(type: string, data: unknown) {
				entries.push({ type, data });
			},
			sendMessage(
				message: { customType: string; content: string; display: boolean },
				options: { triggerTurn: boolean },
			) {
				sent.push({ message, options });
			},
		};
		registerExtension(pi as never);

		const notices: Array<{ text: string; level: string }> = [];
		const ctx = {
			mode: "rpc",
			hasUI: true,
			cwd: directory,
			waitForIdle: async () => {},
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						id: "old-user",
						parentId: null,
						timestamp: "2026-09-01T00:00:00.000Z",
						message: { role: "user", content: "old question" },
					},
					{
						type: "message",
						id: "answer-1",
						parentId: "old-user",
						timestamp: "2026-09-01T00:00:01.000Z",
						message: { role: "assistant", content: [{ type: "text", text: "the answer" }] },
					},
				],
				getSessionId: () => "session-1",
				getSessionFile: () => join(directory, "session.jsonl"),
			},
			ui: {
				editor: async (_title: string, prefill: string) => prefill.replace("> Assistant: the answer", "> Assistant: the answer\nthis needs evidence"),
				notify: (text: string, level: string) => notices.push({ text, level }),
				setEditorText: () => {},
			},
		};

		assert.equal(inputHandlers.length, 1);
		assert.deepEqual(inputHandlers[0]({ text: "first line\nsecond line", source: "interactive" }, ctx), { action: "continue" });
		const journalAfterInput = readFileSync(process.env.PI_ANNOTATE_JOURNAL, "utf8");
		assert.match(journalAfterInput, /## .* · User message/);
		assert.match(journalAfterInput, /> first line\n> second line/);
		assert.deepEqual(inputHandlers[0]({ text: "hidden extension message", source: "extension" }, ctx), { action: "continue" });
		assert.equal(readFileSync(process.env.PI_ANNOTATE_JOURNAL, "utf8"), journalAfterInput);

		await commands.get("annotate")?.handler("1", ctx);

		assert.equal(sent.length, 1);
		assert.match(sent[0].message.content, /this needs evidence/);
		assert.doesNotMatch(sent[0].message.content, /> old question/);
		assert.equal(sent[0].message.display, false);
		assert.equal(sent[0].options.triggerTurn, true);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].type, "pi-annotate-journal");
		const journal = readFileSync(process.env.PI_ANNOTATE_JOURNAL, "utf8");
		assert.match(journal, /this needs evidence/);
		assert.match(journal, /session session-1/);
		assert.ok(notices.some((notice) => notice.level === "info" && notice.text.includes("Saved 1 annotation")));
	} finally {
		if (previousJournal === undefined) delete process.env.PI_ANNOTATE_JOURNAL;
		else process.env.PI_ANNOTATE_JOURNAL = previousJournal;
		rmSync(directory, { recursive: true, force: true });
	}
});
