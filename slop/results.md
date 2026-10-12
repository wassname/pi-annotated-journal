# Editable extension setup

- One checkout: `/home/code/dev/pi-ext/pi-annotated-journal` (resolves to `/workspace/pi-ext/pi-annotated-journal`). Pi's package settings already load this local directory.
- The former `~/.pi/agent/git/github.com/wassname/pi-annotated-journal` checkout is now only a symlink to that directory. Both commit histories, lockfile changes, and task state were preserved.
- Edit `index.ts`, then `/reload`. No build or npm reinstall is needed.
- The first long message asks to enable recording for this session. Accepting records that message too. The answer survives reload; new sessions and forks start off.

Verification: `slop/verification.log` contains the typecheck and test output: `tests 15`, `pass 15`, `fail 0`. The user also reported: “it owrked”.

## Separate scheduler reload error

User reported `coordination.runInBackground is not a function` from the scheduler inside `pi-goals`.

Observed: the installed coordination module exports `runInBackground`. A fresh isolated Pi process loaded the same scheduler successfully and registered its commands, without using or changing the user's task store. The installed Pi reports version 1.1.0; the user's stack refers to bundled files that are no longer present in this installation.

Inference: an old running runtime or cached module is a likely cause. Full restart and resume is the next recovery test; recovery in the user's running session is not yet verified. No scheduler code or saved tasks were changed.

-- PI/OpenAI
