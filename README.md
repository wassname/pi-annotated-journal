# @wassname2/pi-annotated-journal

Copy recent Pi messages as Markdown quotes, add notes, then send them back to Pi.

```bash
pi install npm:@wassname2/pi-annotated-journal
```

```text
/annotate       # last 6 user/assistant messages
/annotate 10    # last 10
/annotate-settings auto on   # record long user messages in this session
/annotate-settings auto off
```

`/annotate` copies blockquoted messages such as:

```text
> Assistant: the answer
> more text
```

Paste them into Pi or an editor, add unquoted notes, then submit them. Automatic recording is off for new sessions. The first message with at least 3 non-empty, unquoted lines asks whether to enable it. Accepting saves that message and future long messages to `docs/human_journal.md` as quoted `User message` records. Declining or dismissing stops further prompts in that session.

The preference is saved in the session and survives resume and `/reload`. New sessions and forks start with recording off; the old global `annotate.json` preference is ignored.

`PI_ANNOTATE_JOURNAL` sets the journal path. Relative paths resolve from Pi's working directory.

<!-- PI -->

## Development

Edit this checkout directly. For a persistent editable install, use `pi install /absolute/path/to/pi-annotated-journal`, then `/reload` after edits. No build is needed.

```bash
npm ci --ignore-scripts
npm run check
```

