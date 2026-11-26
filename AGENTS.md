# Cross Review

Hosts install a copy of `plugins/cross-review/` and nothing else, so the runtime and everything it loads stay inside
that directory, and tests, scripts, and docs stay outside it.

- A change under `plugins/` reaches installed copies only with a version bump: set one new version in the three
  manifests under `plugins/cross-review/` and in `metadata.version` of `.claude-plugin/marketplace.json`, then run
  `npm run build`. `npm test` fails until the shipped files match the digests recorded for that version.
- Each skill's `SKILL.md` stays under 8,000 bytes, because Codex cuts an injected skill off there; `npm test` enforces
  it. It holds only what the host agent must do. Behavior goes in that skill's `references/interface.md` and the
  README, updated in the same change as the code.
- `cross-research` runs the review backends through its `adapters.mjs` and imports only what `runtime.mjs` exports.
  Its `support.mjs` copies the file, lock, and process helpers that `runtime.mjs` keeps private, so a fix to one
  belongs in both.
- The author's `.git/info/exclude` lists `.claude-*`, so `git add` silently skips a new `.claude-plugin/` file. Add
  one with `git add -f`.
- The fake reviewers in `tests/fixtures/` must honor the schema they are given, as the real CLIs do. A behavior all
  three share goes in `fake-common.mjs`.
- A test that waits on a detached worker polls with the suite's `waitFor` or uses `result --wait`, never a short fixed
  budget, since a worker can take many seconds to start on a busy machine.
- `npm run validate`, `npm run smoke`, and `npm run smoke:research` need the real CLIs, and the smokes spend usage.
