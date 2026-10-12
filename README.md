# @wassname2/pi-annotated-journal

Copy recent Pi messages as Markdown quotes, add notes, then send them back to Pi.

```bash
pi install npm:@wassname2/pi-annotated-journal
```

```text
/annotate       # last 6 user/assistant messages
/annotate 10    # last 10
```

`/annotate` copies blockquoted messages such as:

```text
> Assistant: the answer
> more text
```

Paste them into Pi or an editor, add unquoted notes, then submit them.

Automatic saving is off by default. On the first message with at least 3 non-empty, non-quoted lines in a session, Pi asks whether to enable it. Accepting saves that message and future long messages to `docs/human_journal.md` as quoted `User message` records. Declining or dismissing leaves saving off and stops further prompts for that session. Sessions without a UI do not prompt.

The setting applies to all projects. Use `/annotate-settings auto on` or `/annotate-settings auto off` to change it.

`PI_ANNOTATE_JOURNAL` sets the journal path. Relative paths resolve from Pi's working directory.

<!-- PI -->

## Development

```bash
npm install
npm run check
```

