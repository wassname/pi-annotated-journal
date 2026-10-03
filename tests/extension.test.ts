import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import registerExtension from "../index.ts";

function loadExtension(getSession: () => SessionManager, directory: string) {
	const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
	let input!: (event: { text: string; source: string }, ctx: any) => { action: string };
	registerExtension({
		on(_event: string, handler: typeof input) { input = handler; },
		registerCommand(name: string, options: any) { commands.set(name, options); },
		appendEntry(customType: string, data: unknown) { getSession().appendCustomEntry(customType, data); },
	} as never);
	const notifications: string[] = [];
	const ctx = {
		cwd: directory,
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message) },
		get sessionManager() { return getSession(); },
	};
	return { commands, input, notifications, ctx };
}

test("records only long unquoted input when enabled for this session", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-annotate-extension-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	const previousJournal = process.env.PI_ANNOTATE_JOURNAL;
	const journalPath = join(directory, "journal.md");
	process.env.PI_ANNOTATE_JOURNAL = journalPath;
	try {
		writeFileSync(join(directory, "annotate.json"), JSON.stringify({ autoAnnotate: true }));
		const session = SessionManager.inMemory(directory);
		const { commands, input, notifications, ctx } = loadExtension(() => session, directory);
		input({ text: "default\noff\nplease", source: "interactive" }, ctx);
		assert.equal(existsSync(journalPath), false);
		assert.deepEqual(notifications, []);
		const command = commands.get("annotate-settings")!;
		await command.handler("auto on", ctx);
		notifications.length = 0;
		for (const text of ["", "ok", "first\nsecond", "first\n\n \nsecond\n", "> first\n> second\n> third", "first\n> quote\n  > indented quote\nsecond"]) {
			assert.deepEqual(input({ text, source: "interactive" }, ctx), { action: "continue" });
		}
		assert.deepEqual(input({ text: "first\nsecond\nthird", source: "extension" }, ctx), { action: "continue" });
		assert.equal(existsSync(journalPath), false);
		assert.deepEqual(notifications, []);
		assert.deepEqual(input({ text: "first line\r\nsecond line\r\n> quote\r\nthird line", source: "interactive" }, ctx), { action: "continue" });
		const journal = readFileSync(journalPath, "utf8");
		assert.match(journal, /## .* · User message/);
		assert.match(journal, /> first line\n> second line\n> > quote\n> third line/);
		assert.deepEqual(notifications, [`long user message appended to ${journalPath}`]);
		assert.doesNotMatch(journal, /long user message appended/);
		assert.deepEqual(input({ text: "rpc first\nrpc second\nrpc third\nrpc fourth", source: "rpc" }, { ...ctx, hasUI: false }), { action: "continue" });
		assert.match(readFileSync(journalPath, "utf8"), /> rpc fourth/);
		assert.equal(notifications.length, 1);
		assert.equal(commands.get("annotate")?.description, "Copy the last N user/assistant messages as Markdown quotes for annotation (default: 6)");
		await command.handler("auto off", ctx);
		const before = readFileSync(journalPath, "utf8");
		const reloaded = loadExtension(() => session, directory);
		reloaded.input({ text: "not\nsaved\nnow", source: "interactive" }, reloaded.ctx);
		assert.equal(readFileSync(journalPath, "utf8"), before);
		const entries = session.getEntries().length;
		await command.handler("", { ...ctx, ui: { ...ctx.ui, select: async () => undefined } });
		await command.handler("invalid", ctx);
		assert.equal(session.getEntries().length, entries);
		await command.handler("", { ...ctx, ui: { ...ctx.ui, select: async () => "auto on" } });
		reloaded.input({ text: "saved\nagain\nnow", source: "interactive" }, reloaded.ctx);
		assert.match(readFileSync(journalPath, "utf8"), /> saved\n> again\n> now/);
		assert.deepEqual(JSON.parse(readFileSync(join(directory, "annotate.json"), "utf8")), { autoAnnotate: true });
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousJournal === undefined) delete process.env.PI_ANNOTATE_JOURNAL;
		else process.env.PI_ANNOTATE_JOURNAL = previousJournal;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("session preference survives resume and tree navigation without enabling another session or fork", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-annotate-session-"));
	const journalPath = join(directory, "journal.md");
	const previousJournal = process.env.PI_ANNOTATE_JOURNAL;
	process.env.PI_ANNOTATE_JOURNAL = journalPath;
	try {
		let session = SessionManager.create(directory, directory);
		const root = session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		session.appendMessage({
			role: "assistant", content: [{ type: "text", text: "hello" }],
			api: "openai-responses", provider: "openai", model: "test", stopReason: "stop", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		});
		const extension = loadExtension(() => session, directory);
		await extension.commands.get("annotate-settings")!.handler("auto on", extension.ctx);
		const sessionFile = session.getSessionFile()!;
		session = SessionManager.open(sessionFile);
		const reloaded = loadExtension(() => session, directory);
		const record = () => reloaded.input({ text: "first\nsecond\nthird", source: "interactive" }, reloaded.ctx);
		record();
		assert.equal(existsSync(journalPath), true);
		session.branch(root);
		await reloaded.commands.get("annotate-settings")!.handler("auto off", reloaded.ctx);
		session.branch(root);
		const before = readFileSync(journalPath, "utf8");
		record();
		assert.equal(readFileSync(journalPath, "utf8"), before);
		await reloaded.commands.get("annotate-settings")!.handler("auto on", reloaded.ctx);
		session = SessionManager.forkFrom(sessionFile, directory, directory);
		assert.ok(session.getEntries().some(entry => entry.type === "custom" && entry.customType === "pi-annotate-settings"));
		record();
		assert.equal(readFileSync(journalPath, "utf8"), before);
		session = SessionManager.inMemory(directory);
		record();
		assert.equal(readFileSync(journalPath, "utf8"), before);
		session = SessionManager.open(sessionFile);
		record();
		assert.ok(readFileSync(journalPath, "utf8").length > before.length);
	} finally {
		if (previousJournal === undefined) delete process.env.PI_ANNOTATE_JOURNAL;
		else process.env.PI_ANNOTATE_JOURNAL = previousJournal;
		rmSync(directory, { recursive: true, force: true });
	}
});
