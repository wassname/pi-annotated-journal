export const TEMPLATE_VERSION = 1;

export type ConversationRole = "user" | "assistant";

export type ConversationMessage = {
	id: string;
	role: ConversationRole;
	timestamp: string;
	text: string;
};

export type Annotation = {
	messageId: string | null;
	role: ConversationRole | null;
	afterSourceLine: number;
	text: string;
};

export type JournalRecordMetadata = {
	schema: 1;
	recordId: string;
	createdAt: string;
	sessionId: string;
	sessionFile: string | null;
	cwd: string;
	messageIds: string[];
};

const BODY_START = "<!-- pi-annotate-body -->";
const BODY_END = "<!-- /pi-annotate-body -->";
const MESSAGE_PREFIX = "<!-- pi-annotate-message:";
const RECORD_PREFIX = "<!-- pi-annotate-record:";
const RECORD_END = "<!-- /pi-annotate-record -->";

function encodeMetadata(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeMetadata<T>(encoded: string): T {
	return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
}

export function quoteMarkdown(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => (line.length > 0 ? `> ${line}` : ">"))
		.join("\n");
}

export function buildAnnotationTemplate(messages: ConversationMessage[]): string {
	const sections = messages.map((message) => {
		const marker = encodeMetadata({
			id: message.id,
			role: message.role,
			timestamp: message.timestamp,
		});
		const roleLabel = message.role === "user" ? "User" : "Assistant";
		return `${MESSAGE_PREFIX}${marker} -->\n## ${roleLabel}\n\n${quoteMarkdown(message.text)}`;
	});

	return [
		"<!-- pi-annotate-template:v1 -->",
		"<!-- Add feedback as ordinary, unquoted text beside the relevant quoted passage. -->",
		"<!-- Keep the pi-annotate HTML markers. Save and close to submit; leave no annotations to cancel. -->",
		"# Annotate recent conversation",
		"",
		BODY_START,
		sections.join("\n\n"),
		BODY_END,
		"",
	].join("\n");
}

function bodyFromTemplate(markdown: string): string {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const start = lines.indexOf(BODY_START);
	const end = lines.indexOf(BODY_END, start + 1);
	if (start < 0 || end < 0 || end <= start) {
		throw new Error("Annotation markers were removed or reordered. Re-run /annotate and keep the HTML markers.");
	}
	return lines.slice(start + 1, end).join("\n");
}

export function templateMessageIds(markdown: string): string[] {
	const body = bodyFromTemplate(markdown);
	const ids: string[] = [];
	const markerPattern = /^<!-- pi-annotate-message:([A-Za-z0-9_-]+) -->$/gm;
	let match: RegExpExecArray | null;
	while ((match = markerPattern.exec(body)) !== null) {
		let metadata: { id?: unknown; role?: unknown };
		try {
			metadata = decodeMetadata(match[1] ?? "");
		} catch {
			throw new Error("A pi-annotate message marker is invalid. Re-run /annotate and keep the HTML markers.");
		}
		if (typeof metadata.id !== "string" || (metadata.role !== "user" && metadata.role !== "assistant")) {
			throw new Error("A pi-annotate message marker is invalid. Re-run /annotate and keep the HTML markers.");
		}
		ids.push(metadata.id);
	}
	if (ids.length === 0) {
		throw new Error("The pi-annotate message markers were removed. Re-run /annotate and keep the HTML markers.");
	}
	return ids;
}

export function extractAnnotations(markdown: string): Annotation[] {
	const body = bodyFromTemplate(markdown);
	templateMessageIds(markdown);
	const annotations: Annotation[] = [];
	let messageId: string | null = null;
	let role: ConversationRole | null = null;
	let sourceLine = 0;
	let pending: string[] = [];
	let pendingAfterLine = 0;

	const flush = () => {
		const text = pending.join("\n").trim();
		if (text) {
			annotations.push({ messageId, role, afterSourceLine: pendingAfterLine, text });
		}
		pending = [];
	};

	for (const line of body.split("\n")) {
		if (line.startsWith(MESSAGE_PREFIX) && line.endsWith(" -->")) {
			flush();
			const encoded = line.slice(MESSAGE_PREFIX.length, -4);
			let metadata: { id?: unknown; role?: unknown };
			try {
				metadata = decodeMetadata(encoded);
			} catch {
				throw new Error("A pi-annotate message marker is invalid. Re-run /annotate and keep the HTML markers.");
			}
			if (typeof metadata.id !== "string" || (metadata.role !== "user" && metadata.role !== "assistant")) {
				throw new Error("A pi-annotate message marker is invalid. Re-run /annotate and keep the HTML markers.");
			}
			messageId = metadata.id;
			role = metadata.role;
			sourceLine = 0;
			continue;
		}

		if ((line === "## User" && role === "user") || (line === "## Assistant" && role === "assistant")) {
			continue;
		}

		if (line.startsWith(">")) {
			flush();
			sourceLine += 1;
			continue;
		}

		if (/^<!--.*-->$/.test(line.trim())) {
			flush();
			continue;
		}

		if (line.trim() === "") {
			flush();
			continue;
		}

		if (pending.length === 0) pendingAfterLine = sourceLine;
		pending.push(line);
	}
	flush();

	return annotations;
}

export function buildPrompt(editedTemplate: string): string {
	const annotatedConversation = bodyFromTemplate(editedTemplate)
		.split("\n")
		.filter((line) => !/^<!-- pi-annotate-message:[A-Za-z0-9_-]+ -->$/.test(line))
		.join("\n")
		.trim();
	return annotatedConversation;
}

export function buildJournalRecord(metadata: JournalRecordMetadata, editedTemplate: string): string {
	const encoded = encodeMetadata(metadata);
	const body = bodyFromTemplate(editedTemplate);
	return [
		`## ${metadata.createdAt} · session ${metadata.sessionId}`,
		"",
		`${RECORD_PREFIX}${encoded} -->`,
		BODY_START,
		body,
		BODY_END,
		RECORD_END,
		"",
	].join("\n");
}

export function journalHeader(): string {
	return [
		"# Human supervision journal",
		"",
		"Human-authored annotations captured by `/annotate`. Quoted text is prior conversation; unquoted text is feedback at that location.",
		"",
	].join("\n");
}

export type ParsedJournalRecord = {
	metadata: JournalRecordMetadata;
	template: string;
	annotations: Annotation[];
};

export function parseJournalRecords(markdown: string): ParsedJournalRecord[] {
	const records: ParsedJournalRecord[] = [];
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const match = lines[index]?.match(/^<!-- pi-annotate-record:([A-Za-z0-9_-]+) -->$/);
		if (!match) continue;
		const end = lines.indexOf(RECORD_END, index + 1);
		if (end < 0) throw new Error("Journal contains an unterminated pi-annotate record.");
		const metadata = decodeMetadata<JournalRecordMetadata>(match[1] ?? "");
		const template = lines.slice(index + 1, end).join("\n").trim();
		const actualMessageIds = templateMessageIds(template);
		if (JSON.stringify(actualMessageIds) !== JSON.stringify(metadata.messageIds)) {
			throw new Error(`Journal record ${metadata.recordId} has missing or reordered message markers.`);
		}
		records.push({ metadata, template, annotations: extractAnnotations(template) });
		index = end;
	}
	return records;
}
