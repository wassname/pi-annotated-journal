# @wassname2/pi-annotated-journal

Annotate recent Pi messages in `$VISUAL` or `$EDITOR`, and keep the feedback in a Markdown journal.

```bash
pi install npm:@wassname2/pi-annotated-journal
```

```text
/annotate       # last 6 user/assistant messages
/annotate 10    # last 10
```

Pi opens a Markdown transcript with every source line blockquoted. Write feedback as unquoted
text near the line it refers to, then save and close. The extension then:

1. appends the annotated transcript to `docs/human_journal.md`;
2. records the entry in the Pi session;
3. sends the transcript to the model as hidden context and starts the next turn.

Nothing is saved or sent if you add no unquoted text. An editor error cancels the operation.
Without `$VISUAL` or `$EDITOR`, Pi's built-in editor is used.

Every interactive or RPC prompt is also appended as a quoted `User message` record. Extension-injected messages are excluded. The journal is not added to model context automatically; ask Pi to read it when it is useful.

`PI_ANNOTATE_JOURNAL` sets the journal path. Relative paths resolve from Pi's working directory.

<!-- PI -->

## Export supervision data

```bash
pi-supervision-export --journal docs/human_journal.md --output supervision.jsonl
```

Reads the session files referenced by the journal. `--session PATH`, repeatable, restricts the
export. Records are typed `user_message` or `human_annotation`; an annotation carries the message
ID and the source line it follows.

## Development

```bash
npm install
npm run check
```

The external-editor flow is adapted from
[pi-annotated-reply](https://github.com/omaclaren/pi-annotated-reply).
