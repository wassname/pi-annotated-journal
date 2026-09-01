#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BODY_START = "<!-- pi-annotate-body -->";
const BODY_END = "<!-- /pi-annotate-body -->";
const RECORD_END = "<!-- /pi-annotate-record -->";
const MESSAGE_PREFIX = "<!-- pi-annotate-message:";

function usage(exitCode = 0) {
	const stream = exitCode === 0 ? process.stdout : process.stderr;
	stream.write(`Usage: pi-supervision-export [options]\n\nOptions:\n  --journal PATH   Journal path (default: docs/human_journal.md)\n  --session PATH   Pi session JSONL; repeat for more than one\n  --output PATH    Write JSONL here instead of stdout\n  --help           Show this help\n\nWithout --session, session files referenced by journal records are read automatically.\n`);
	process.exit(exitCode);
}

function parseArgs(argv) {
	const options = { journal: "docs/human_journal.md", sessions: [], output: null };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") usage();
		if (arg === "--journal" || arg === "--session" || arg === "--output") {
			const value = argv[++i];
			if (!value) usage(2);
			if (arg === "--journal") options.journal = value;
			if (arg === "--session") options.sessions.push(value);
			if (arg === "--output") options.output = value;
			continue;
		}
		process.stderr.write(`Unknown argument: ${arg}\n`);
		usage(2);
	}
	return options;
}

function decode(encoded) {
	return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

function parseAnnotations(template) {
	const templateLines = template.replace(/\r\n/g, "\n").split("\n");
	const start = templateLines.indexOf(BODY_START);
	const end = templateLines.indexOf(BODY_END, start + 1);
	if (start < 0 || end < 0 || end <= start) throw new Error("Malformed annotation body");
	const body = templateLines.slice(start + 1, end).join("\n");
	const annotations = [];
	let messageId = null;
	let role = null;
	let sourceLine = 0;
	let pending = [];
	let pendingAfterLine = 0;
	const flush = () => {
		const text = pending.join("\n").trim();
		if (text) annotations.push({ messageId, role, afterSourceLine: pendingAfterLine, text });
		pending = [];
	};

	for (const line of body.split("\n")) {
		if (line.startsWith(MESSAGE_PREFIX) && line.endsWith(" -->")) {
			flush();
			const marker = decode(line.slice(MESSAGE_PREFIX.length, -4));
			messageId = marker.id;
			role = marker.role;
			sourceLine = 0;
			continue;
		}
		if ((line === "## User" && role === "user") || (line === "## Assistant" && role === "assistant")) continue;
		if (line.startsWith(">")) {
			flush();
			sourceLine += 1;
			continue;
		}
		if (/^<!--.*-->$/.test(line.trim()) || line.trim() === "") {
			flush();
			continue;
		}
		if (pending.length === 0) pendingAfterLine = sourceLine;
		pending.push(line);
	}
	flush();
	return annotations;
}

function parseJournal(path) {
	const lines = readFileSync(path, "utf8").replace(/\r\n/g, "\n").split("\n");
	const records = [];
	for (let index = 0; index < lines.length; index += 1) {
		const match = lines[index]?.match(/^<!-- pi-annotate-record:([A-Za-z0-9_-]+) -->$/);
		if (!match) continue;
		const end = lines.indexOf(RECORD_END, index + 1);
		if (end < 0) throw new Error(`Unterminated journal record at line ${index + 1}`);
		const metadata = decode(match[1]);
		const template = lines.slice(index + 1, end).join("\n").trim();
		records.push({ metadata, annotations: parseAnnotations(template) });
		index = end;
	}
	return records;
}

function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n\n");
}

function readSession(path) {
	const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
	let sessionId = null;
	const records = [];
	for (let index = 0; index < lines.length; index += 1) {
		let entry;
		try {
			entry = JSON.parse(lines[index]);
		} catch (error) {
			throw new Error(`${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (entry.type === "session") sessionId = entry.id;
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = contentText(entry.message.content);
		if (text.includes("<!-- pi-annotate-template:v1 -->")) continue;
		records.push({
			type: "user_message",
			timestamp: entry.timestamp ?? new Date(entry.message.timestamp).toISOString(),
			sessionId,
			sessionFile: path,
			entryId: entry.id,
			parentId: entry.parentId ?? null,
			text,
		});
	}
	return { sessionId, records };
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const journalPath = resolve(options.journal);
	const journalRecords = parseJournal(journalPath);
	const explicitSessions = options.sessions.map((path) => resolve(path));
	const sessionPaths = explicitSessions.length > 0
		? explicitSessions
		: [...new Set(journalRecords.map((record) => record.metadata.sessionFile).filter(Boolean))];

	const output = [];
	const selectedSessionIds = new Set();
	for (const path of sessionPaths) {
		try {
			const session = readSession(path);
			if (session.sessionId) selectedSessionIds.add(session.sessionId);
			output.push(...session.records);
		} catch (error) {
			process.stderr.write(`warning: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	}

	for (const record of journalRecords) {
		if (explicitSessions.length > 0 && !selectedSessionIds.has(record.metadata.sessionId)) continue;
		record.annotations.forEach((annotation, ordinal) => {
			output.push({
				type: "human_annotation",
				timestamp: record.metadata.createdAt,
				sessionId: record.metadata.sessionId,
				sessionFile: record.metadata.sessionFile,
				recordId: record.metadata.recordId,
				ordinal,
				messageId: annotation.messageId,
				role: annotation.role,
				afterSourceLine: annotation.afterSourceLine,
				text: annotation.text,
			});
		});
	}

	output.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || (a.ordinal ?? -1) - (b.ordinal ?? -1));
	const jsonl = output.map((record) => JSON.stringify(record)).join("\n") + (output.length > 0 ? "\n" : "");
	if (options.output) writeFileSync(resolve(options.output), jsonl, "utf8");
	else process.stdout.write(jsonl);
}

try {
	main();
} catch (error) {
	process.stderr.write(`pi-supervision-export: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
