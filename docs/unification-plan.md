# Plan: unify claude-review and codex-review, then improve both

Status: revision 3, 2026-09-16, after two Codex review rounds (see section
10). Nothing here is implemented yet except where marked "(done in
codex-review)".

## 1. Goals

1. One repository ships both plugins: claude-review (a Codex plugin that asks
   Claude Code to review) and codex-review (a Claude Code plugin that asks Codex
   to review), with one shared runtime and a thin backend per reviewer.
2. Reviewers get full capabilities by default: run tests, write scratch code,
   install tools, download libraries, drive browsers. The runtime protects the
   reviewed checkout with rules and verification, not by removing tools.
3. Review quality improvements ranked from the comparables study: vendor
   rubrics in the prompt, stable finding IDs, an on-disk decisions ledger,
   size-aware context, a host-side double-check step, a wider secret filter,
   delimited untrusted context.
4. The user-facing CLI and the session model stay as they are. Existing
   `tmp/claude_reviews/` and `tmp/codex_reviews/` state keeps working.

Non-goals: stop-gate hooks, auto-review nudges after edits, an MCP bridge, the
Codex app-server native reviewer, multi-model debate protocols.

## 2. Facts the plan relies on

Verified on this machine unless noted.

- After a mechanical Claude/Codex rename, the two runtimes differ in 228 of
  about 1,600 lines. The differences are the invocation arguments, output
  parsing, conversation identity, the version check, and prose.
- Both hosts copy an installed plugin out of the source repo. Claude Code
  installs from the marketplace `source` subdirectory into
  `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>`; Codex installs
  into `~/.codex/plugins/cache`. Shared code outside a plugin directory is not
  present after install, so each plugin directory must be self-contained.
- Codex CLI 0.153.4: `codex exec -` and `codex exec resume <thread> -` both
  accept `--json`, `-o`, `--output-schema`, `-m`, `-c key=value`, and
  `--skip-git-repo-check`. `-s` and `--add-dir` exist only on `exec`, so
  sandbox and writable roots go through `-c sandbox_mode=...`,
  `-c sandbox_workspace_write.network_access=true`, and
  `-c 'sandbox_workspace_write.writable_roots=[...]'`. Both overrides were
  exercised end to end: the reviewer wrote a file into the extra root.
  Reasoning effort accepts minimal, low, medium, high, xhigh, max, ultra.
- On Codex 0.153.4, `-c mcp_servers={}` does not disable MCP servers, because
  `-c` merges tables. A read-only review could still call the `node_repl`
  server. Per-server `-c mcp_servers.<name>.enabled=false` overrides disable
  servers with bare names (the same reviewer then reports that no such tool
  exists) but fail configuration loading for names containing dots, quoted
  or not. A profile-v2 layer file (`$CODEX_HOME/<profile>.config.toml`,
  passed with `-p <profile>`) using quoted table keys disables both kinds;
  verified in an isolated `CODEX_HOME`.
- Claude Code 2.1.273: `--permission-mode` accepts acceptEdits, auto,
  bypassPermissions, manual, and more; `--dangerously-skip-permissions`,
  `--allowedTools`, `--tools`, `--setting-sources`, `--strict-mcp-config`
  exist. `claude -p --session-id` and `--resume` are what claude-review uses
  today. `claude -p --permission-mode bypassPermissions` runs Bash with no
  extra flag.
- Codex's native review rubric is at
  codex-rs/prompts/templates/review/rubric.md in openai/codex, Apache-2.0.
- Claude Code's Bash tool caps one call at 10 minutes; Codex's shell tool has
  its own timeout. Detached background workers survive both.

## 3. Repository layout

Rename the existing `raghubetina/codex-review` repository to a neutral name
(working title `cross-review`; alternatives: `agent-review`, `second-opinion`)
so GitHub redirects keep the current install path alive until both hosts are
re-pointed. Import claude-review by copying its files in one commit whose
message cites the source repository and commit; archive `claude-review` with a
README pointer once the Codex marketplace path from the new repo is verified.

```text
cross-review/
  .claude-plugin/marketplace.json        Claude Code marketplace -> plugins/codex-review
  .agents/plugins/marketplace.json       Codex marketplace       -> plugins/claude-review
  src/
    runtime.mjs                          shared core (CLI, git, sessions, jobs, context, prompt, render)
    backends/claude.mjs                  invocation args, output parsing, version check
    backends/codex.mjs
  plugins/
    codex-review/.claude-plugin/plugin.json
    codex-review/skills/codex-review/{SKILL.md, references/interface.md, scripts/}
    claude-review/.codex-plugin/plugin.json
    claude-review/skills/claude-review/{SKILL.md, references/interface.md, agents/openai.yaml, scripts/}
  scripts/build.mjs                      copies src/ into each plugin's scripts/ directory
  tests/
    fixtures/fake-claude.mjs, fake-codex.mjs
    runtime.test.mjs                     parametrized over both backends
    build.test.mjs                       asserts the copied runtime matches src/
```

Each plugin's `scripts/` holds `<name>.mjs`, a five-line entry that imports the
copied `runtime.mjs` and calls `main({ backend: "codex" })`, plus the copied
`runtime.mjs` and `backends/`. No bundler and no dependencies; the build is a
copy, and a test fails when the copies drift. The copies are committed so a
plugin install needs no build step.

## 4. Backend contract

```js
{
  name: "codex",
  reviewerLabel: "Codex",
  artifactDirectory: "tmp/codex_reviews",
  binaryEnv: "CODEX_REVIEW_CODEX_BIN",
  minVersion: [0, 136, 0],
  checkVersion(binary),
  conversationStrategy: "assigned" | "chosen",
  buildArgs({ job, session, schemaPath, lastMessagePath, scratchDir, capability, mcp }),
  parseOutput({ stdout, lastMessage }),
  optionSchema: { "max-budget-usd": ... },
  hostGuidance: { backgroundFirst: true, waitCallCeilingMinutes: 5 }
}
```

- `conversationStrategy` captures the one structural difference. Claude lets
  the plugin choose the session id (`--session-id`), so the plugin session id
  and the Claude session id can stay equal. Codex assigns the thread id, so the
  runtime records `conversation_id` after the first turn. The session file
  gains `conversation_id`; for legacy claude-review sessions it defaults to
  `session_id`.
- `parseOutput` returns `{ structured, rawResult, conversationId, usage,
  degraded }`. The runtime, not the backend, validates the structure, computes
  finding ids, sorts, and renders.
- Backend-specific options (`--max-budget-usd` for Claude) live in
  `optionSchema`; the other backend rejects them with a clear message.
- The prompt is shared. Backend text differs only in the tool sentence and the
  scratch-directory sentence.

## 5. Reviewer capabilities

New option `--capability <full|workspace|read-only>`, default `full`,
recorded per job and shown in the artifact header.

| Mode | Codex backend | Claude backend |
| --- | --- | --- |
| full | `sandbox_mode="danger-full-access"`, `approval_policy="never"` | `--permission-mode bypassPermissions`, all tools |
| workspace | `sandbox_mode="workspace-write"`, `network_access=true`, `writable_roots=[scratch]` | same as full (Claude Code has no OS sandbox in `-p` mode; revisit if `--settings sandbox` proves usable) |
| read-only | `sandbox_mode="read-only"`, `approval_policy="never"` (today's behavior) | `--tools Read,Glob,Grep --permission-mode dontAsk` (today's behavior) |

MCP servers from the user's own Codex or Claude config are inherited in
`full` and `workspace` modes, so a Playwright MCP server or a docs server is
available to the reviewer. `read-only` mode disables them by default, because
neither host applies a read-only policy to MCP tools. `--mcp` and `--no-mcp`
override the per-mode default.

Mechanism, verified on Codex 0.153.4: the runtime runs `codex mcp list
--json`, takes every server with `enabled: true`, writes
`$CODEX_HOME/codex-review-no-mcp.config.toml` containing one
`[mcp_servers."<name>"]` table with `enabled = false` per server (quoted keys,
so names with dots work), and passes `-p codex-review-no-mcp`. Dotted `-c`
overrides are not used because they cannot address names containing dots.
The file is rewritten on every such run, documented in the README, and if
discovery fails or the file cannot be written the review does not start. For
Claude the flag is `--strict-mcp-config`. The current codex-review passed the
no-op `mcp_servers={}` and documented MCP as disabled; that was removed and
the docs corrected on 2026-09-16.

Guardrails that apply in every mode:

1. Scratch directory. Each session gets `<artifact-root>/<task>/scratch/`,
   already ignored through `info/exclude`. The prompt names it as the only
   place inside the repository the reviewer may create files, and says scratch
   work persists across rounds so a test harness from round one is reusable.
2. Checkout rules in the prompt. Leave the reviewed checkout as found: no
   edits to tracked files, no new files outside scratch, no git commands that
   change refs, the index, the stash, or the working tree, no commits, no
   pushes, and revert any experiment before finishing.
3. Runtime verification. Before invoking the reviewer, record HEAD and the
   working-tree fingerprint. Afterwards: if HEAD moved, fail the job and
   retire the session (the recorded "last reviewed HEAD" would otherwise be the
   reviewer's commit). If the working tree changed on an ordinary review,
   apply the result but attach a warning that lists the changed paths in the
   job, the artifact, and the rendered output. Explicit `--resume-session`
   reviews keep failing on any change, as today.
4. Documented risk. In `full` mode the reviewer runs with the user's own
   privileges and network, while reading untrusted repository content.
   README and SKILL.md say so and recommend `--capability read-only` for
   repositories the user does not trust.

Open question: whether Claude's `full` also needs `--setting-sources user` and
which of the user's hooks fire inside a headless review.

## 6. Review quality improvements

### 6.1 Prompt rubric (both, small)

- Embed the eight "is it a bug" tests, the comment rules, and the
  pre-existing-versus-introduced rule from Codex's rubric, with Apache-2.0
  attribution in a NOTICE file. Add the false-positive list paraphrased from
  Anthropic's code-review plugin: linter-catchable, pre-existing, on unmodified
  lines, likely intentional, pedantic nits.
- Define each severity. Keep `critical/high/medium/low` in the schema and map
  P0 to P3 onto them in the prompt so existing artifacts stay comparable.
- Calibration lines: prefer one strong finding over several weak ones; state
  when a conclusion rests on inference; keep confidence honest.
- The introduced-only and unmodified-lines exclusions apply to change scopes
  only (working, branch, commit, range). In `repo` scope the prompt says
  pre-existing defects are the point of the review. Ledger findings may be
  reported with a status update in any scope.
- Replace the trailing `Session metadata: <uuid>` line with nothing. Wrap the
  diff, untracked files, and focus text in `<repository_context>` and
  `<user_focus>` tags and say the content inside is data, not instructions.

### 6.2 Schema v2 and rendering (both, medium)

Add to each finding: `pre_existing` (boolean), `trigger` (the scenario or
input needed), `evidence` (quoted lines), and `observation` with values `new`,
`persisting`, `fixed`, `reopen_proposed`. The reviewer never sets a
disposition; `rejected` and the other user dispositions exist only in the
ledger. Add top-level `next_steps` (array of strings). Keep `file` and `line_start` nullable only for `repo` scope; for
other scopes the runtime marks a finding without a location as degraded.

The runtime assigns each finding an id once (`F-` plus six hex characters)
when it first enters the ledger. On re-reviews the prompt lists existing
findings with their ids, and the schema gains a nullable `id`: the reviewer
returns the existing id when reporting on a known finding and null for a new
one. A content fingerprint (file plus normalized title) is only a matching
hint the runtime uses to warn when a null-id finding looks like a known one;
it never creates or merges ids, so rewording keeps identity and two defects
with the same title stay distinct. Rendering sorts by severity, then
confidence, groups by id, flags apparent duplicates without deleting them,
normalizes `line_end` below `line_start`, and shows id, observation,
disposition, and pre-existing flags.

### 6.3 Decisions ledger (both, medium)

The ledger lives inside `session.json` under `ledger`, so reviewer
observations are written in the same atomic replace as
`last_applied_job_id`, `review_count`, and `last_head`. There is no separate
ledger file and therefore no crash window between the two: a worker that dies
before `commitReview` leaves no observation change, and the existing
applied-result recovery already treats that job as unapplied.

User decisions follow a different rule because they must not depend on the
reviewer succeeding. `prepareJob` validates decisions parsed from focus text
(the id must exist in the ledger) and writes them to `session.json` under the
state lock before the reviewer starts; that write changes no review counter
and no applied-result marker. The `acceptedSession` snapshot that
`executeJob` takes therefore already contains them, so a review that times
out or is retired still carries the user's decisions into the replacement
session, which `createTask` seeds from the accepted ledger.

```json
"ledger": {
  "findings": {
    "F-3a2b9c": {
      "first_job": "review-...", "last_job": "review-...",
      "severity": "high", "title": "...", "file": "...", "line_start": 12,
      "observation": "persisting",
      "disposition": "rejected",
      "decision": { "text": "callback API is public", "job_id": "review-...", "at": "..." }
    }
  },
  "notes": [ { "text": "...", "job_id": "...", "at": "..." } ]
}
```

- `observation` is the reviewer's latest report (`new`, `persisting`, `fixed`,
  `reopen_proposed`) and is overwritten by every applied review that mentions
  the id. Findings the reviewer omits keep their previous observation; the
  prompt asks for an explicit `fixed`.
- `disposition` belongs to the user (`open`, `accepted`, `rejected`,
  `deferred`) and changes only through focus text: `again -- reject F-3a2b9c:
  public API`, `accept F-...`, `defer F-...`, `reopen F-...`. Reviewer output
  never changes a disposition.
- A rejected finding the reviewer reports again must carry
  `observation: reopen_proposed`; the prompt allows that only when new
  evidence materially changes the finding, and rendering shows it as a
  proposal, not a finding. The user reopens it with `reopen F-...` or leaves
  it rejected.
- Other focus text is stored as a session note.
- Every re-review prompt gets a compact "Prior findings and decisions" table
  from the ledger, whether or not the reviewer's conversation resumed. This is
  what makes continuity survive retirement.
- `again` after retirement therefore works: new conversation, inherited ledger,
  and the output says so.

### 6.4 Size-aware context (both, small)

Measure the diff first. Inline it when it is at most 256 KB and at most 40
files. Otherwise send the changed-file list, `git log --oneline` for the
range, `git diff --stat`, and the base and merge-base SHAs, plus a
capability-aware way to get the patch:

- When the reviewer can run git (Codex in every mode, Claude in `full`), an
  instruction to run `git diff <range> -- <path>` per file.
- When it cannot (Claude `read-only`), the runtime writes per-file patches to
  `<task>/context/<job-id>/NNN-<path>.patch` plus the whole diff, and lists
  their absolute paths for the Read tool. Root commits and working-scope
  untracked files go through the same writer.

Filtering happens once, in a shared collection stage that runs before either
transport: filename rules, content sniffing, and binary detection produce one
filtered patch set, and both inline delivery and the patch-file writer consume
it. A test feeds the same sensitive inputs through both routes and asserts
identical skip lists, so a private key in an untracked file is omitted below
and above the inline threshold alike.

Always include log and stat for branch, range, and commit scopes. Keep the
8 MB cut only as a last resort for untracked content and add a 2 MB total cap
on inlined untracked files, listing what was skipped.

### 6.5 Secret filter (both, small)

Extend `likelySecretPath` with `.netrc`, `.npmrc`, `.pypirc`, `*.tfvars`,
`id_ed25519*`, `id_ecdsa*`, `*.jks`, `*.keystore`, `.htpasswd`,
`*.kdbx`. Sniff inlined untracked content for `-----BEGIN ... PRIVATE KEY-----`
and `AKIA[0-9A-Z]{16}` and replace the file body with a skip note. Tests cover
each pattern.

### 6.6 Host double-check step (both, small)

SKILL.md for both hosts gains a step after results arrive: read only the lines
each finding cites, classify it as agree, disagree with evidence, nuance,
false positive, or uncited, and report the classification with the findings.
Citations are resolved against the reviewed revision, not the current
filesystem: `git show <scope tip>:<path>` for committed scopes, and the
working tree for working scope only after the recorded fingerprint still
matches. A location that cannot be resolved is unverifiable, not a false
positive; a false positive is a location that exists at the reviewed revision
but does not contain the claimed code. The host reads enough surrounding
lines to judge the claim and must not edit code.

### 6.7 Carried over from codex-review (done in codex-review)

`status --wait` and `result --wait` with `--wait-minutes` (default 5), the
five-second wait windows in the timing-sensitive tests, and the Thread ID line
in output. All move into the shared core, so claude-review gets them.

### 6.8 Record the conversation id early (both, small)

Backends declare how the conversation id becomes known. `chosen` (Claude):
the runtime picks the session id and records it on the job in `prepareJob`,
which is also where a resumed job of either backend copies the session's
existing id. `assigned` (Codex): the backend exposes an incremental event
hook; the runtime feeds it stdout as it arrives and, on the first
`thread.started` event, writes `thread_id` to the job file only, never to the
session, so early metadata can never count as an applied result. Claude's
`--output-format json` emits one result at exit and has no early event, which
is why the hook is Codex-only. Either way `status` shows the id while the
review runs, and a review killed mid-flight leaves a handle that `codex
resume` or `claude --resume` can open. (Done in codex-review for the Codex
side on 2026-09-16.)

## 7. Compatibility and migration

- `STATE_VERSION` becomes 2. Session files are upgraded on read with a
  backend-specific rule: Codex sessions copy their existing `thread_id` into
  `conversation_id`, Claude sessions copy `session_id`. A Codex session with
  neither keeps refusing to resume, as today. A missing ledger starts empty.
  Migration is tested by upgrading a legacy file and then asserting the
  resume arguments the backend builds.
- Job files gain `capability`, `tree_warning`, and `conversation_id`. Old
  jobs render unchanged.
- Old artifacts are never rewritten.
- CLI stays backward compatible; new flags are `--capability`, `--no-mcp`,
  `--wait-minutes`. `--max-budget-usd` remains on the Claude backend.

## 8. Sequencing

Each phase ends with green tests for both backends, one squashed commit, a
Codex review of the diff through codex-review, and a Claude review through
claude-review.

- Phase 0, repo. Rename, import claude-review, both marketplaces from one
  repo, both installs verified from GitHub. Half a day.
- Phase 1, shared core. Extract `src/runtime.mjs` and the two backends from
  the two runtimes, copy step, parametrized tests. The 228-line diff is the
  worklist. One day.
- Phase 2, capabilities. Modes, scratch directory, checkout rules, HEAD and
  tree verification, MCP inheritance, docs. Half a day plus live runs in each
  mode against both CLIs.
- Phase 3, rubric and schema v2. Prompt, schema, renderer, NOTICE. Half a
  day, then compare artifacts on the same diff before and after.
- Phase 4, ledger. Storage, decision parsing, prompt injection, retirement
  inheritance. One day.
- Phase 5, context and secrets. Size-aware collection, caps, filter. Half a
  day.
- Phase 6, host double-check and docs. Quarter day.

## 9. Open decisions

1. Repository name.
2. Default capability `full` accepted as the risk posture for the user's own
   repositories.
3. Keep `critical/high/medium/low` or switch the schema to P0 to P3.
4. Whether the Claude backend keeps `--setting-sources user` in `full` mode.
5. Whether to preserve claude-review's git history with a subtree import or
   cite it in one commit.
6. Whether `read-only` mode disables MCP servers by default, as the review
   recommends, given that neither host applies a read-only policy to MCP
   tools.

## 10. Review log

Revision 1 was reviewed by Codex (max effort) through codex-review itself, job
`review-mu3ytci3-8bb89e`, thread `01a0a9c9-956d-7043-b00c-f6278d76a55d`.
Findings and how revision 2 answers them:

1. High. `mcp_servers={}` does not disable MCP servers on Codex 0.153.4, and
   inherited MCP tools escape both hosts' read-only controls. Section 5
   rewritten; see also the fix to the current codex-review noted there.
2. High. Defaulting `conversation_id` to `session_id` would break legacy Codex
   sessions that store `thread_id`. Section 7 now migrates per backend.
3. Medium. Hashing file plus title is not a stable identity. Section 6.2 now
   assigns ids once and has the reviewer reference them.
4. Medium. A separate ledger file has a crash window against the applied
   result marker. Section 6.3 now stores the ledger inside `session.json`.
5. Medium. Model statuses would overwrite user decisions. Section 6.3 now
   separates `observation` from `disposition` with explicit transitions.
6. Medium. The large-diff fallback assumed git access that Claude read-only
   mode lacks. Section 6.4 is now capability-aware and writes patch files.
7. Medium. Introduced-only rules would suppress `repo` scope findings.
   Section 6.1 scopes the exclusions.
8. Medium. The double-check step resolved citations against the current
   filesystem. Section 6.6 resolves them against the reviewed revision.

Revision 2 was reviewed on the same Codex thread (`again`, job
`review-mu3z9uiz-58cdc5`). It confirmed 2, 3, 4, 7, and 8 resolved and raised
five points, answered in revision 3:

1. High. The patch-file route bypassed the untracked-content secret sniff.
   Section 6.4 now filters once before either transport, with a parity test.
2. Medium. User decisions supplied with a failed review were lost with the
   retired session. Section 6.3 now persists decisions at preparation time.
3. Medium. The reviewer `status` enum and the ledger's `reopen_proposed` were
   inconsistent. Section 6.2 now has one `observation` enum; dispositions are
   ledger-only.
4. Medium. Dotted MCP server names break `mcp_servers.<name>.enabled=false`
   overrides. Section 5 now uses a profile-v2 layer file with quoted keys and
   fails closed.
5. Medium. Claude has no early event under `--output-format json`. Section
   6.8 now records chosen ids at preparation and limits the event hook to
   Codex.
