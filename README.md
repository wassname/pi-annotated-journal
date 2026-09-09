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

Paste them into Pi or an editor, add unquoted notes, then submit them. Submitted prompts are appended to `docs/human_journal.md` as quoted `User message` records.

`PI_ANNOTATE_JOURNAL` sets the journal path. Relative paths resolve from Pi's working directory.

<!-- PI -->

## Development

```bash
npm install
npm run check
```

