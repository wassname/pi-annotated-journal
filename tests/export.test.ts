import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildAnnotationTemplate, buildJournalRecord, journalHeader } from "../src/core.ts";

test("exporter combines user messages and anchored journal annotations", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-supervision-test-"));
	try {
		const sessionPath = join(directory, "session.jsonl");
		const journalPath = join(directory, "human_journal.md");
		writeFileSync(
			sessionPath,
			[
				JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-09-01T00:00:00.000Z", cwd: directory }),
				JSON.stringify({
					type: "message",
					id: "user0001",
					parentId: null,
					timestamp: "2026-09-01T00:00:01.000Z",
					message: { role: "user", content: "question\n<!-- /pi-annotate-record -->\nafter", timestamp: 1788220801000 },
				}),
				JSON.stringify({
					type: "message",
					id: "generated-annotation-prompt",
					parentId: "user0001",
					timestamp: "2026-09-01T00:00:02.000Z",
					message: { role: "user", content: "feedback copy\n<!-- pi-annotate-template:v1 -->", timestamp: 1788220802000 },
				}),
			].join("\n") + "\n",
			"utf8",
		);
		const template = buildAnnotationTemplate([
			{
				id: "user0001",
				role: "user",
				timestamp: "2026-09-01T00:00:01.000Z",
				text: "question\n<!-- /pi-annotate-record -->\nafter",
			},
		]).replace("> after", "> after\nmore specifically, use six hours");
		writeFileSync(
			journalPath,
			journalHeader() + buildJournalRecord({
				schema: 1,
				recordId: "record-1",
				createdAt: "2026-09-01T00:00:02.000Z",
				sessionId: "session-1",
				sessionFile: sessionPath,
				cwd: directory,
				messageIds: ["user0001"],
			}, template),
			"utf8",
		);

		const run = spawnSync(process.execPath, [resolve("scripts/export-supervision.mjs"), "--journal", journalPath], {
			cwd: resolve("."),
			encoding: "utf8",
		});
		assert.equal(run.status, 0, run.stderr);
		const records = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(records.map((record) => record.type), ["user_message", "human_annotation"]);
		assert.equal(records[1].messageId, "user0001");
		assert.equal(records[1].afterSourceLine, 3);
		assert.equal(records[1].text, "more specifically, use six hours");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
