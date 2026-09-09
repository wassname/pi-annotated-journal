import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
	buildAnnotationTemplate,
	buildJournalRecord,
	buildPrompt,
	buildUserMessageRecord,
	extractAnnotations,
	journalHeader,
	type ConversationMessage,
	type ConversationRole,
	type JournalRecordMetadata,
	type UserMessageRecordMetadata,
} from "./src/core.ts";

const DEFAULT_MESSAGE_COUNT = 6;
const MAX_MESSAGE_COUNT = 100;
const DEFAULT_JOURNAL_PATH = "docs/human_journal.md";

type EditorResult =
	| { ok: true; edited: string }
	| { ok: false; cancelled: true }
	| { ok: false; message: string };

type ParsedEditor = { command: string; args: string[] };

function parseCount(args: string): number | null {
	const value = args.trim();
	if (!value) return DEFAULT_MESSAGE_COUNT;
	if (!/^\d+$/.test(value)) return null;
	const count = Number(value);
	return Number.isSafeInteger(count) && count >= 1 && count <= MAX_MESSAGE_COUNT ? count : null;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trimEnd();
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object" || !("type" in part)) return "";
			if (part.type === "text" && "text" in part && typeof part.text === "string") return part.text;
			if (part.type === "image") return "[image omitted from annotation view]";
			return "";
		})
		.filter(Boolean)
		.join("\n\n")
		.trimEnd();
}

function conversationMessage(entry: SessionEntry): ConversationMessage | null {
	if (entry.type !== "message") return null;
	const message = entry.message;
	if (message.role !== "user" && message.role !== "assistant") return null;
	const text = textFromContent(message.content);
	if (!text.trim()) return null;
	return {
		id: entry.id,
		role: message.role as ConversationRole,
		timestamp: entry.timestamp,
		text,
	};
}

function recentConversation(ctx: ExtensionCommandContext, count: number): ConversationMessage[] {
	return ctx.sessionManager
		.getBranch()
		.map(conversationMessage)
		.filter((message): message is ConversationMessage => message !== null)
		.slice(-count);
}

function parseEditorCommand(spec: string): ParsedEditor | null {
	const tokens = spec.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
	if (!tokens?.length) return null;
	const unquote = (token: string) => {
		if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
			return token.slice(1, -1);
		}
		return token;
	};
	const command = unquote(tokens[0] ?? "").trim();
	if (!command) return null;
	return { command, args: tokens.slice(1).map(unquote) };
}

async function editExternally(ctx: ExtensionCommandContext, prefill: string, commandSpec: string): Promise<EditorResult> {
	const editor = parseEditorCommand(commandSpec);
	if (!editor) return { ok: false, message: `Could not parse $VISUAL/$EDITOR: ${commandSpec}` };

	const result = await ctx.ui.custom<EditorResult>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `Opening ${editor.command}...`);
		let settled = false;
		const finish = (value: EditorResult) => {
			if (settled) return;
			settled = true;
			done(value);
		};
		loader.onAbort = () => finish({ ok: false, cancelled: true });

		void Promise.resolve().then(() => {
			const tempDirectory = mkdtempSync(join(tmpdir(), "pi-annotate-"));
			const tempFile = join(tempDirectory, "annotation.md");
			let tuiStopped = false;
			try {
				writeFileSync(tempFile, prefill, { encoding: "utf8", mode: 0o600 });
				if (settled) return;
				tui.stop();
				tuiStopped = true;
				const run = spawnSync(editor.command, [...editor.args, tempFile], { stdio: "inherit" });
				if (run.error) return finish({ ok: false, message: run.error.message });
				if (run.status !== 0) return finish({ ok: false, cancelled: true });
				finish({ ok: true, edited: readFileSync(tempFile, "utf8") });
			} catch (error) {
				finish({ ok: false, message: error instanceof Error ? error.message : String(error) });
			} finally {
				rmSync(tempDirectory, { recursive: true, force: true });
				if (tuiStopped) {
					tui.start();
					tui.requestRender(true);
				}
			}
		});

		return loader;
	});
	return result ?? { ok: false, cancelled: true };
}

async function editAnnotation(ctx: ExtensionCommandContext, prefill: string): Promise<EditorResult> {
	const commandSpec = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
	if (ctx.mode === "tui" && commandSpec) return editExternally(ctx, prefill, commandSpec);
	if (!ctx.hasUI) return { ok: false, message: "/annotate requires interactive Pi mode." };
	if (!commandSpec) ctx.ui.notify("No $VISUAL/$EDITOR set; using Pi's built-in editor.", "warning");
	const edited = await ctx.ui.editor("Annotate recent conversation", prefill);
	return edited === undefined ? { ok: false, cancelled: true } : { ok: true, edited };
}

function journalPath(ctx: { cwd: string }): string {
	const configured = process.env.PI_ANNOTATE_JOURNAL?.trim() || DEFAULT_JOURNAL_PATH;
	return isAbsolute(configured) ? configured : resolve(ctx.cwd, configured);
}

function appendJournal(path: string, record: string): void {
	mkdirSync(dirname(path), { recursive: true });
	if (!existsSync(path)) {
		writeFileSync(path, journalHeader(), { encoding: "utf8", mode: 0o600 });
	}
	const existing = readFileSync(path, "utf8");
	const separator = existing.length === 0 || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
	appendFileSync(path, `${separator}${record}`, "utf8");
}

export default function (pi: ExtensionAPI) {
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const metadata: UserMessageRecordMetadata = {
			schema: 1,
			createdAt: new Date().toISOString(),
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? null,
			cwd: ctx.cwd,
			source: event.source,
		};
		appendJournal(journalPath(ctx), buildUserMessageRecord(metadata, event.text));
		return { action: "continue" };
	});

	pi.registerCommand("annotate", {
		description: "Annotate the last N user/assistant messages in $EDITOR (default: 6), journal the feedback, and send it",
		handler: async (args, ctx) => {
			const count = parseCount(args);
			if (count === null) {
				ctx.ui.notify(`Usage: /annotate [N], where N is 1-${MAX_MESSAGE_COUNT}.`, "warning");
				return;
			}

			await ctx.waitForIdle();
			const messages = recentConversation(ctx, count);
			if (messages.length === 0) {
				ctx.ui.notify("No user or assistant text found in the current branch.", "warning");
				return;
			}

			const edited = await editAnnotation(ctx, buildAnnotationTemplate(messages));
			if (!edited.ok) {
				if ("cancelled" in edited) ctx.ui.notify("Annotation cancelled.", "info");
				else ctx.ui.notify(edited.message, "error");
				return;
			}

			let annotations;
			try {
				annotations = extractAnnotations(edited.edited, messages.map((message) => message.id));
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			if (annotations.length === 0) {
				ctx.ui.notify("No unquoted annotations found; nothing was sent or journaled.", "info");
				return;
			}

			const createdAt = new Date().toISOString();
			const path = journalPath(ctx);
			const metadata: JournalRecordMetadata = {
				schema: 1,
				recordId: randomUUID(),
				createdAt,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile() ?? null,
				cwd: ctx.cwd,
				messageIds: messages.map((message) => message.id),
			};

			try {
				appendJournal(path, buildJournalRecord(metadata, edited.edited));
			} catch (error) {
				ctx.ui.notify(`Could not write ${path}: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			pi.appendEntry("pi-annotate-journal", {
				recordId: metadata.recordId,
				journalPath: path,
				messageIds: metadata.messageIds,
				annotationCount: annotations.length,
			});

			const prompt = buildPrompt(edited.edited);
			try {
				pi.sendMessage(
					{
						customType: "pi-annotated-journal",
						content: prompt,
						display: false,
						details: { recordId: metadata.recordId },
					},
					{ triggerTurn: true },
				);
				ctx.ui.notify(`Saved ${annotations.length} annotation${annotations.length === 1 ? "" : "s"} to ${path}.`, "info");
			} catch (error) {
				ctx.ui.setEditorText(prompt);
				ctx.ui.notify(
					`Journal saved, but automatic submission failed. The prompt is loaded in Pi's editor: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
