# pi-annotated-journal

Annotate recent Pi messages in `$VISUAL` or `$EDITOR`:

```text
/annotate       # last 6 user/assistant messages
/annotate 10    # last 10
```

Pi opens a Markdown transcript. Every source line is blockquoted. Add feedback as unquoted text near the relevant line, then save and close. The extension:

1. appends the annotated transcript to `docs/human_journal.md`;
2. records the journal entry in the Pi session; and
3. submits the annotated transcript as the next user message.

No feedback is saved or sent when the document has no unquoted annotations. An editor error also cancels the operation. If `$VISUAL` and `$EDITOR` are unset, the command uses Pi's built-in editor.

The external-editor flow is adapted from [pi-annotated-reply](https://github.com/omaclaren/pi-annotated-reply).

Set `PI_ANNOTATE_JOURNAL` to change the journal path. Relative paths resolve from Pi's working directory.

## Install this checkout

```bash
pi install /home/ubuntu/projects/pi-annotated-journal
```

Run `/reload` in an existing Pi session after installation.

## Export supervision data

The package includes a small JSONL exporter. By default it reads the session files referenced by the journal:

```bash
pi-supervision-export \
  --journal docs/human_journal.md \
  --output supervision.jsonl
```

Pass `--session PATH` one or more times to restrict the export. Output records have type `user_message` or `human_annotation`. An annotation includes the message ID and the source line after which it was inserted.

## Development

```bash
npm install
npm run check
```

<!-- Drafted by Sol. -->
