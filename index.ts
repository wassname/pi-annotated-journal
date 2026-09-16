import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import {
	buildAnnotationTemplate,
	buildUserMessageRecord,
	journalHeader,
	type ConversationMessage,
	type ConversationRole,
	type UserMessageRecordMetadata,
} from "./src/core.ts";

const DEFAULT_MESSAGE_COUNT = 6;
const MAX_MESSAGE_COUNT = 100;
const DEFAULT_JOURNAL_PATH = "docs/human_journal.md";

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

function copyToClipboard(text: string, useOsc52: boolean): void {
	const errors: string[] = [];
	for (const [command, args] of [["pbcopy", []], ["wl-copy", []], ["xclip", ["-selection", "clipboard"]]] as Array<[string, string[]]>) {
		try {
			execFileSync(command, args, { input: text, stdio: ["pipe", "ignore", "pipe"] });
			return;
		} catch (error) {
			errors.push(`${command}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (useOsc52 && process.stdout.isTTY) {
		process.stdout.write(`\u001b]52;c;${Buffer.from(text).toString("base64")}\u0007`);
		return;
	}
	throw new Error(`No clipboard command succeeded. ${errors.join("; ")}`);
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

function settingsPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi/agent");
	return resolve(agentDir.replace(/^~(?=\/|$)/, homedir()), "annotate.json");
}

function autoAnnotateEnabled(): boolean {
	if (!existsSync(settingsPath())) return false;
	try {
		return JSON.parse(readFileSync(settingsPath(), "utf8")).autoAnnotate === true;
	} catch {
		// Never record user input when the saved preference cannot be read.
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("input", (event, ctx) => {
		if (event.source === "extension" || !autoAnnotateEnabled()) return { action: "continue" };
		const unquotedLines = event.text.split(/\r?\n/).filter((line) => {
			const trimmed = line.trim();
			return trimmed.length > 0 && !trimmed.startsWith(">");
		});
		if (unquotedLines.length < 3) return { action: "continue" };
		const metadata: UserMessageRecordMetadata = {
			schema: 1,
			createdAt: new Date().toISOString(),
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? null,
			cwd: ctx.cwd,
			source: event.source,
		};
		const path = journalPath(ctx);
		appendJournal(path, buildUserMessageRecord(metadata, event.text));
		if (ctx.hasUI) ctx.ui.notify(`long user message appended to ${path}`, "info");
		return { action: "continue" };
	});

	pi.registerCommand("annotate-settings", {
		description: "Configure automatic annotation (off by default)",
		getArgumentCompletions: (prefix) => ["auto off", "auto on"]
			.filter((value) => value.startsWith(prefix))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const option = args.trim();
			let choice = option;
			if (!option) {
				if (!ctx.hasUI) return;
				const selected = await ctx.ui.select(
					`Auto-annotate long user messages: ${autoAnnotateEnabled() ? "on" : "off"} (all projects)`,
					["auto off", "auto on"],
				);
				if (!selected) return;
				choice = selected;
			}
			if (choice !== "auto on" && choice !== "auto off") {
				ctx.ui.notify("Usage: /annotate-settings [auto on|off]", "warning");
				return;
			}
			try {
				const path = settingsPath();
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, JSON.stringify({ autoAnnotate: choice === "auto on" }, null, 2) + "\n", { mode: 0o600 });
				ctx.ui.notify(`Auto-annotate ${choice === "auto on" ? "on" : "off"} (saved for all projects).`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not save annotation settings: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("annotate", {
		description: "Copy the last N user/assistant messages as Markdown quotes for annotation (default: 6)",
		handler: async (args, ctx) => {
			const count = parseCount(args);
			if (count === null) {
				ctx.ui.notify(`Usage: /annotate [N], /annotate-settings. N is 1-${MAX_MESSAGE_COUNT}.`, "warning");
				return;
			}

			await ctx.waitForIdle();
			const messages = recentConversation(ctx, count);
			if (messages.length === 0) {
				ctx.ui.notify("No user or assistant text found in the current branch.", "warning");
				return;
			}

			try {
				copyToClipboard(buildAnnotationTemplate(messages), ctx.mode === "tui");
				ctx.ui.notify("Copied to clipboard. Paste here or in an editor to annotate.", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
