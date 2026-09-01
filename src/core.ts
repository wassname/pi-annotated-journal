export const TEMPLATE_VERSION = 2;

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

const TEMPLATE_HEADING = "# Annotate";
const SEPARATOR = "---";
const BODY_START = "<!-- pi-annotate-body -->";
const BODY_END = "<!-- /pi-annotate-body -->";
const RECORD_PREFIX = "<!-- pi-annotate-record:";
const RECORD_END = "<!-- /pi-annotate-record -->";
const LEGACY_MESSAGE_PREFIX = "<!-- pi-annotate-message:";

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

function quoteMessage(message: ConversationMessage): string {
	const role = message.role === "user" ? "User" : "Assistant";
	const [first = "", ...rest] = message.text.replace(/\r\n/g, "\n").split("\n");
	const lines = [`> ${role}: ${first}`, ...rest.map((line) => (line.length > 0 ? `> ${line}` : ">"))];
	return lines.join("\n");
}

export function buildAnnotationTemplate(messages: ConversationMessage[]): string {
	return [TEMPLATE_HEADING, "", messages.map(quoteMessage).join(`\n\n${SEPARATOR}\n\n`), ""].join("\n");
}

function flushAnnotation(
	annotations: Annotation[],
	pending: string[],
	messageId: string | null,
	role: ConversationRole | null,
	afterSourceLine: number,
): void {
	const text = pending.join("\n").trim();
	if (text) annotations.push({ messageId, role, afterSourceLine, text });
	pending.length = 0;
}

function extractCurrentAnnotations(markdown: string, messageIds: readonly string[]): Annotation[] {
	const annotations: Annotation[] = [];
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	let sectionIndex = 0;
	let sectionCount = 0;
	let role: ConversationRole | null = null;
	let sourceLine = 0;
	let pending: string[] = [];
	let pendingAfterLine = 0;

	const flush = () => flushAnnotation(
		annotations,
		pending,
		messageIds[sectionIndex] ?? null,
		role,
		pendingAfterLine,
	);

	for (const line of lines) {
		if (line === TEMPLATE_HEADING && sectionCount === 0 && sourceLine === 0) continue;
		if (line === SEPARATOR) {
			flush();
			sectionIndex += 1;
			role = null;
			sourceLine = 0;
			continue;
		}
		if (line.startsWith(">")) {
			flush();
			if (sourceLine === 0) {
				const match = line.match(/^> (User|Assistant):(?: |$)/);
				if (!match) throw new Error("A message heading was changed. Re-run /annotate and keep the quoted User/Assistant prefixes.");
				role = match[1] === "User" ? "user" : "assistant";
				sectionCount += 1;
			}
			sourceLine += 1;
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

	if (messageIds.length > 0 && sectionCount !== messageIds.length) {
		throw new Error("Message separators were changed. Re-run /annotate and keep the quoted messages and --- separators.");
	}
	return annotations;
}

function bodyFromJournalRecord(markdown: string): string {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const start = lines.indexOf(BODY_START);
	const end = lines.indexOf(BODY_END, start + 1);
	if (start < 0 || end < 0 || end <= start) throw new Error("Journal record has invalid body markers.");
	return lines.slice(start + 1, end).join("\n");
}

function extractLegacyAnnotations(markdown: string): Annotation[] {
	const body = bodyFromJournalRecord(markdown);
	const annotations: Annotation[] = [];
	let messageId: string | null = null;
	let role: ConversationRole | null = null;
	let sourceLine = 0;
	let pending: string[] = [];
	let pendingAfterLine = 0;
	const flush = () => flushAnnotation(annotations, pending, messageId, role, pendingAfterLine);

	for (const line of body.split("\n")) {
		if (line.startsWith(LEGACY_MESSAGE_PREFIX) && line.endsWith(" -->")) {
			flush();
			const metadata = decodeMetadata<{ id: string; role: ConversationRole }>(line.slice(LEGACY_MESSAGE_PREFIX.length, -4));
			messageId = metadata.id;
			role = metadata.role;
			sourceLine = 0;
			continue;
		}
		if (line === "## User" || line === "## Assistant" || /^<!--.*-->$/.test(line.trim())) continue;
		if (line.startsWith(">")) {
			flush();
			sourceLine += 1;
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

export function extractAnnotations(markdown: string, messageIds: readonly string[] = []): Annotation[] {
	return extractCurrentAnnotations(markdown, messageIds);
}

export function buildPrompt(editedTemplate: string): string {
	return editedTemplate.replace(/\r\n/g, "\n").trim();
}

export function buildJournalRecord(metadata: JournalRecordMetadata, editedTemplate: string): string {
	const encoded = encodeMetadata(metadata);
	return [
		`## ${metadata.createdAt} · session ${metadata.sessionId}`,
		"",
		`${RECORD_PREFIX}${encoded} -->`,
		BODY_START,
		editedTemplate.replace(/\r\n/g, "\n").trim(),
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
		const recordBody = lines.slice(index + 1, end).join("\n").trim();
		const template = bodyFromJournalRecord(recordBody);
		const annotations = template.includes("<!-- pi-annotate-template:v1 -->")
			? extractLegacyAnnotations(recordBody)
			: extractCurrentAnnotations(template, metadata.messageIds);
		records.push({ metadata, template, annotations });
		index = end;
	}
	return records;
}
