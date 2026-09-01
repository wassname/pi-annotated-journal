import assert from "node:assert/strict";
import test from "node:test";
import {
	buildAnnotationTemplate,
	buildJournalRecord,
	buildPrompt,
	extractAnnotations,
	journalHeader,
	parseJournalRecords,
	quoteMarkdown,
	type ConversationMessage,
} from "../src/core.ts";

const messages: ConversationMessage[] = [
	{ id: "user0001", role: "user", timestamp: "2026-09-01T00:00:00.000Z", text: "first line\n\n> nested quote" },
	{ id: "asst0001", role: "assistant", timestamp: "2026-09-01T00:00:01.000Z", text: "answer line one\nanswer line two" },
];

test("quoteMarkdown quotes every source line, including blanks and existing quotes", () => {
	assert.equal(quoteMarkdown(messages[0].text), "> first line\n>\n> > nested quote");
});

test("extractAnnotations returns unquoted blocks with message and line anchors", () => {
	const template = buildAnnotationTemplate(messages)
		.replace("> first line", "> first line\nthis assumption is wrong")
		.replace("> answer line two", "> answer line two\n\nuse the earlier value instead\nand rerun the test");

	assert.deepEqual(extractAnnotations(template), [
		{ messageId: "user0001", role: "user", afterSourceLine: 1, text: "this assumption is wrong" },
		{
			messageId: "asst0001",
			role: "assistant",
			afterSourceLine: 2,
			text: "use the earlier value instead\nand rerun the test",
		},
	]);
});

test("generated headings and instructions are not annotations", () => {
	assert.deepEqual(extractAnnotations(buildAnnotationTemplate(messages)), []);
});

test("removed body or message markers fail instead of silently losing annotation anchors", () => {
	assert.throws(() => extractAnnotations("no markers"), /markers were removed or reordered/);
	assert.throws(
		() => extractAnnotations("<!-- pi-annotate-body -->\nfeedback\n<!-- /pi-annotate-body -->"),
		/message markers were removed/,
	);
});

test("journal records retain metadata and parsed annotations", () => {
	const edited = buildAnnotationTemplate(messages).replace("> answer line one", "> answer line one\ncheck this number");
	const metadata = {
		schema: 1 as const,
		recordId: "record-1",
		createdAt: "2026-09-01T00:02:00.000Z",
		sessionId: "session-1",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp/project",
		messageIds: messages.map((message) => message.id),
	};
	const journal = journalHeader() + buildJournalRecord(metadata, edited);
	const parsed = parseJournalRecords(journal);

	assert.equal(parsed.length, 1);
	assert.deepEqual(parsed[0].metadata, metadata);
	assert.deepEqual(parsed[0].annotations, [
		{ messageId: "asst0001", role: "assistant", afterSourceLine: 1, text: "check this number" },
	]);
});

test("source text that resembles structural markers cannot truncate a record", () => {
	const markerMessages: ConversationMessage[] = [{
		id: "asst-marker",
		role: "assistant",
		timestamp: "2026-09-01T00:00:01.000Z",
		text: "before\n<!-- pi-annotate-message:foo -->\n<!-- /pi-annotate-body -->\n<!-- /pi-annotate-record -->\nafter",
	}];
	const edited = buildAnnotationTemplate(markerMessages).replace("> after", "> after\nkeep all source lines");
	const metadata = {
		schema: 1 as const,
		recordId: "record-marker",
		createdAt: "2026-09-01T00:02:00.000Z",
		sessionId: "session-marker",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp/project",
		messageIds: ["asst-marker"],
	};
	const journal = journalHeader() + buildJournalRecord(metadata, edited);
	assert.match(journal, /> <!-- \/pi-annotate-body -->/);
	assert.match(journal, /> after/);
	assert.equal(parseJournalRecords(journal)[0].annotations[0].text, "keep all source lines");
});

test("prompt contains only the annotated conversation", () => {
	const prompt = buildPrompt(buildAnnotationTemplate(messages));
	assert.match(prompt, /^## User/);
	assert.match(prompt, /## Assistant/);
	assert.match(prompt, /> answer line one/);
	assert.doesNotMatch(prompt, /pi-annotate/);
	assert.doesNotMatch(prompt, /user0001|asst0001/);
});
