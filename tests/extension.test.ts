import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerExtension from "../index.ts";

test("/annotate journals feedback and sends it as the next user message", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-annotate-extension-"));
	const previousJournal = process.env.PI_ANNOTATE_JOURNAL;
	process.env.PI_ANNOTATE_JOURNAL = join(directory, "human_journal.md");
	try {
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const sent: string[] = [];
		const entries: Array<{ type: string; data: unknown }> = [];
		const pi = {
			registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, options);
			},
			appendEntry(type: string, data: unknown) {
				entries.push({ type, data });
			},
			sendUserMessage(prompt: string) {
				sent.push(prompt);
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
				editor: async (_title: string, prefill: string) => prefill.replace("> the answer", "> the answer\nthis needs evidence"),
				notify: (text: string, level: string) => notices.push({ text, level }),
				setEditorText: () => {},
			},
		};

		await commands.get("annotate")?.handler("1", ctx);

		assert.equal(sent.length, 1);
		assert.match(sent[0], /this needs evidence/);
		assert.doesNotMatch(sent[0], /> old question/);
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
