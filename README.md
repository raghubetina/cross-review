# Cross Review

A plugin that lets one coding agent ask a different one for a code review of an exact Git scope, keeping one persistent reviewer conversation per repository and branch session so a re-review remembers earlier findings and your decisions about them.

| Host | Reviewers | Invoke |
| --- | --- | --- |
| Claude Code | Codex, Antigravity CLI | ask naturally, or `/cross-review codex branch main` |
| Codex | Claude Code, Antigravity CLI | ask naturally, or `$cross-review claude branch main` |
| Antigravity CLI (`agy`) | Codex, Claude Code | ask naturally |

Every reviewer shares the same session model: explicit scopes (`working`, `branch [base]`, `commit [ref]`, `range <from>..<to>`, `repo`), `again` to re-review in the same conversation, `--resume-session` for exact resumes across branch identity changes, detached background jobs with `status`, `result`, and `cancel`, secret-filtered Git context on stdin, and a JSON-schema-enforced result. How this came to be one plugin is in [docs/unification-plan.md](docs/unification-plan.md).

## Install

Requirements: Node.js 18.18 or newer, Git, your host, and the CLI of each reviewer you will use, installed and logged in: Codex CLI 0.136 or newer, Claude Code 2.1.205 or newer, Antigravity CLI 1.5.1 or newer. Tested with Codex CLI 0.166.0, Claude Code 2.1.318, and Antigravity CLI 1.5.1.

```sh
# Claude Code
claude plugin marketplace add raghubetina/cross-review
claude plugin install cross-review@cross-review

# Codex
codex plugin marketplace add raghubetina/cross-review
codex plugin add cross-review@cross-review

# Antigravity CLI
agy plugin install https://github.com/raghubetina/cross-review/tree/main/plugins/cross-review
```

During development: `claude --plugin-dir /absolute/path/to/cross-review/plugins/cross-review`, or `codex plugin marketplace add /absolute/path/to/cross-review` then the same `codex plugin add`, or `agy plugin install /absolute/path/to/cross-review/plugins/cross-review`.

After installing in Codex, start a new Codex process; in the ChatGPT desktop app, fully quit and reopen it so it rescans marketplaces. In Codex CLI, invoke the skill with `$cross-review`; `/cross-review` is not a slash command.

In Antigravity CLI, `agy -p` runs only the commands an allow rule permits, and one it refuses ends the turn with an empty result, so allow `node` when you script it. Do not host reviews under `agy --sandbox`, because the reviewer needs the network and its own state.

Inside a Codex sandbox with no network, the runtime refuses to start a review and says why, because the reviewer could not reach its API. A sandbox with network access can also fail to write to `.git/info/exclude`, where the runtime records its artifact directory.

## Use

The reviewer comes first on the command line. If you name none, the runtime uses the only reviewer other than the agent it runs inside, leaving out `agy`, which runs only when named; on `agy`, which has two, it asks you to choose. A review by the agent it runs inside is refused, since that agent's own review command does the job, unless you pass `--allow-self`. A reviewer cannot start another review; the one way around that is a Codex reviewer whose `shell_environment_policy.include_only` leaves out the runtime's `CROSS_REVIEW_DEPTH` marker.

Reviews run as detached background jobs because a max-effort review often outlasts a host's per-call time limit; `result --wait` blocks for up to `--wait-minutes` (default 5) and can be called again. Every result prints a plugin session ID and the reviewer's conversation ID, which `codex resume <thread-id>`, `claude --resume <session-id>`, or `agy --conversation <conversation-id>` opens interactively. Artifacts live in the reviewed repository's ignored `tmp/codex_reviews/` and `tmp/claude_reviews/` directories, and each reviewer keeps its own sessions and ledger.

Details: [SKILL.md](plugins/cross-review/skills/cross-review/SKILL.md) and [interface.md](plugins/cross-review/skills/cross-review/references/interface.md).

## Antigravity and Google's terms

The `agy` reviewer runs only after you opt in by setting `CROSS_REVIEW_AGY_AUTH=login` in your environment, because Google's own texts conflict on using a consumer login this way. The [FAQ](https://antigravity.google/docs/faq) says "Wrapping `agy` inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans" and recommends a Gemini Enterprise or Google AI Studio API key for third-party coding agents. Item 6 of the [terms](https://antigravity.google/terms) names suspension or termination for using third-party software to access the service. A [forum moderator](https://discuss.ai.google.dev/t/is-invoking-the-official-agy-cli-from-a-local-ai-coding-assistant-allowed-on-an-individual-google-ai-account/185992) has called spawning the unmodified binary locally for your own use "a supported use of the CLI", but a follow-up asking whether that is Google's official reading has no answer.

This plugin running inside `agy` and calling Codex or Claude does not wrap `agy`, but item 6 also covers using the service "in connection with products not provided by us", so read the terms yourself. Item 5 says Google staff may review what you submit unless you change a setting, so check that before working on private code.

The reviewer runs only when you name it, never on a schedule, and spends your own allowance: in tests on AI Pro, a review of up to 256 KB at the default medium effort took a little over 1% of Gemini 4 Argon's weekly allowance. It is always read-only, because a repository's hooks and MCP commands run with no trust prompt wherever `agy` starts, even under `--sandbox`. So it starts in an empty directory outside the repository, and refuses to start if `TMPDIR` is inside any Git repository. From there it can read files and run read-only `git` but cannot run your tests. Every review stays in your `agy` conversation history.

## Moving from codex-review and claude-review

The two earlier plugins became this one in 0.9.0. Review sessions carry over, because artifacts stay where they were. On each machine:

```sh
# Claude Code: the marketplace's rename rewrites your settings, but the plugin still needs installing
claude plugin marketplace update cross-review
claude plugin list
claude plugin install cross-review@cross-review

# Codex: there is no rename, so let running reviews finish first
codex plugin marketplace upgrade cross-review
codex plugin add cross-review@cross-review
codex plugin remove claude-review@cross-review
```

Restart Claude Code and start a new Codex session afterward. In a project that enables the plugin, commit the `.claude/settings.json` that Claude Code rewrites, and change the key in `.codex/config.toml` by hand, because Codex ignores a stale key without saying so.

## Update

Hosts install a copy of the plugin, and decide whether to fetch a new one by the version in the plugin manifest, so a change pushed without a version bump never reaches an installed copy. For example, 707adc0 removed the 30-minute default deadline without a bump, and copies of 0.7.2 installed before it kept that deadline.

A release therefore sets one new version in the three manifests under `plugins/cross-review/` and in `metadata.version` of `.claude-plugin/marketplace.json`, then runs `npm run build`. The build records a digest of the plugin's shipped files for the new version in `scripts/plugin-digests.json`; each manifest's own version is left out of its digest. `npm test` fails when the manifests disagree on the version, or when the shipped files differ from the digests recorded for that version. The build never records digests for a version that the record on `origin/main` lists with other digests, since a version listed there may already be installed; until the first push, it records a version's digests again after each fix.

Then, on each machine:

```sh
# Claude Code
claude plugin marketplace update cross-review
claude plugin update cross-review@cross-review

# Codex
codex plugin marketplace upgrade cross-review
codex plugin add cross-review@cross-review

# Antigravity CLI, which has no update command: installing again replaces the copy
agy plugin install https://github.com/raghubetina/cross-review/tree/main/plugins/cross-review
```

Restart Claude Code and start a new Codex session afterward; each loads plugins at startup.

## Session semantics

`again` repeats the previous scope in the current branch session. `--resume-session <session-id>` is the explicit exact-scope path for resuming an active session when branch identity changes. It requires a clean, committed scope; the stored tip must remain an ancestor of the current HEAD, the requested scope tip must equal that HEAD, and no other active session may own the destination checkout identity. Only this explicit-resume path samples the checkout's named-or-detached identity, HEAD, and cleanliness before invoking the reviewer and before applying the result. Leave that checkout untouched while the review runs; a transient change restored between samples cannot be detected.

A review has no deadline unless `--timeout-minutes` sets one. Once a reviewer process starts, any error, timeout, cancellation, worker death, checkout mismatch, malformed result, or persistence failure that prevents its result from being applied retires the plugin session at its last accepted scope and HEAD. Cancellation therefore ends continuity. `again` explains why a retired session cannot resume; an ordinary review starts a new isolated session and reports that transition. `new` starts a fresh session, and `reset` forgets the active session without deleting its artifacts. If necessary, the runtime adds a reviewer's artifact directory to Git's local `info/exclude`; it never modifies the tracked `.gitignore`.

## Result format

Every review returns a verdict, a terse summary, findings, next steps, and residual risk, enforced by a JSON schema. Each finding carries an id (`F-` plus six hex characters, assigned by the runtime and shown back to the reviewer in every later round), an observation (`new`, `persisting`, `fixed`, or `reopen_proposed`), a severity (`critical`, `high`, `medium`, `low`, defined in the prompt with Codex's P0 to P3 meanings), a location, whether it is pre-existing, the trigger, quoted evidence, a confidence, and a recommendation. The runtime sorts findings by severity then confidence, flags a repeated id or a missing location, and records every finding in the session's ledger. The prompt embeds a rubric adapted from Codex's own review rubric (see NOTICE) plus false-positive rules adapted from Anthropic's code-review plugin: nothing a linter or compiler would catch, nothing in a change scope that already existed before the change, no nits a senior engineer would not raise. A problem the change causes on lines it did not touch counts as introduced, for example a caller it breaks, a test it invalidates, or a present-tense claim in documentation that it makes false; such a finding cites the untouched location. When the change extends a problem that already existed, the extension also counts as introduced, for example new inputs it sends into an old defect, or a further respect in which it makes an already partly stale claim false. A rubric file replaces this built-in rubric for one round; see [Audit](#audit).

## Focus

Text after `--` is the review focus: what to look at, feedback on the last round, and decisions. `--focus-file <path>` adds a file's text to the focus, for standing instructions kept in a file, such as a repository's review checklist. A relative path resolves against the current directory, not `--dir`, and the file may live outside the reviewed repository. The runtime reads the file on the host when it prepares the review, and fails before recording anything if it cannot. The reviewer sees the file's text first, labeled with its path, then the `--` text. The session ledger records the file's path and SHA-256 rather than its text. Pass `--focus-file` again on each round that should include it.

## Audit

Two more options turn a review into a line-by-line audit, for example of machine-generated code, where the usual question is whether each line is worth keeping. They are independent, and each applies to one round only, so pass them again on every round that should use them. A round with either option also reviews generated files in the resolved scope, which an ordinary review skips, since the line under audit or the claim under verification may be in one. Every other checkout rule stays: the artifact directories, `.git`, dependency and vendor trees, and credential files remain off limits, and the reviewer still writes only to scratch and never commits or pushes. As runtime arguments after the reviewer:

```text
new repo --background --rubric-file audit/rubric.md --checklist-file audit/checklist.txt
again --background --rubric-file audit/rubric.md --checklist-file audit/checklist.txt -- Look again at the controllers
```

`--rubric-file <path>` puts the file's text in place of the built-in rules for what counts as a finding and how severe it is. With those rules go the built-in exclusions: linter nits, intentional-looking choices, and the rule that a change scope reports only what the change introduced, so a rubric restates any of these it still wants. It must define the schema's severities, `critical`, `high`, `medium`, and `low`.

`--checklist-file <path>` lists the items the reviewer must answer, one per line as `<id> <description>`. The id is the first word; blank lines and lines starting with `#` are skipped; a duplicate id, a line without a description, or a file without items fails before anything is recorded. Items can be normalized line shapes to audit, or another reviewer's findings to verify. The result then carries exactly one verdict per item, each with a one-line note: `keep` (the code earns its place), `finding` (the reviewer reported findings about it), `confirm` or `refute` (the code supports or contradicts the claim the item states), or `not_applicable`. Each finding names the items it answers, and the runtime derives a verdict's finding ids from those links. Without a rubric, a checklist runs under the built-in rubric, for example to have one reviewer confirm or refute the other's findings.

The runtime checks the verdicts against the checklist but never invents one. The prompt shows each id in backticks and asks for bare ids. A verdict or link that copies an item's listed line instead, such as `` `id` `` or `id: description`, counts for that id, and the `Coverage:` line says how many labels were normalized. A label that fits two ids, such as `a—b: x` when both `a` and `a—b` are listed, counts for the longer and is reported in the warning. Items without a verdict, verdicts or links naming items not on the list, an item answered twice, a `finding` verdict that no finding links to, and a finding linked to an item marked `keep` or `not_applicable` are reported in one `Warning:` line and in the artifact's warning section. `result` and `status` print a `Coverage:` line with the count of each verdict, and the rendered result ends with a checklist coverage section listing each item's verdict. Each completed round writes `<task>/<seq>-<scope>.verdicts.json` next to its artifact, with the checklist, the coverage, and the verdicts in checklist order; a failed or cancelled round leaves none and prints no `Coverage:` line. `cite` prints the `Coverage:` and `Verdicts:` lines before the findings, and under each finding the checklist items it links. The session ledger records each file's path and SHA-256, like a focus file. Verdicts never change a finding's disposition.

A verdict for every item does not prove that the reviewer inspected every item; the notes, and a confirm or refute round by the other reviewer, are the check. Split a very large checklist across rounds, and rerun with a checklist of only the missing ids. Have the rubric ask for titles that name the specific line: a finding reported without its known id resembles any earlier one with the same file and title within 25 lines, and folds into it before the next round. Start each audit with `new`, which keeps it separate from earlier reviews. A later ordinary review would resume the audit's conversation and inherit its findings, so start that one with `new` too.

## Decisions

Your verdict on a finding is a decision, written at the start of a sentence or line in the `--` focus text: `reject F-1a2b3c: reason`, `accept F-...`, `defer F-...`, or `reopen F-...`. A reason runs to the next semicolon or line end, so put each decision on its own line or separate them with semicolons. A phrase shaped like a decision that the runtime did not record, such as `accept F-...` inside a reason, gets a `Warning:` line naming it. Decisions are never read from a focus file, so a committed file cannot record one. The runtime records it before the reviewer starts, so it survives a failed review or a retired session, and it shows every prior finding with its observation, disposition, and decision to the reviewer in each later round. Reviewer output never changes a disposition: a rejected finding can only come back as a reopen proposal with new evidence. When a retired session is replaced, or the branch history is rewritten under an active session, the new session inherits the ledger and says so; `new` starts without it. An id printed with a `resembles` flag folds into the earlier finding before the next round and stays usable as an alias, unless you have already decided on the earlier finding; then both stay separate for you to decide.

## What the reviewer receives

Every review starts from a filtered view of the change: files whose names look like credentials (`.env*`, `.netrc`, `.npmrc`, `.pypirc`, `.htpasswd`, `credentials*`, `secrets*`, `token*`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.tfvars`, `*.jks`, `*.keystore`, `*.kdbx`) are left out by name; an untracked file whose content looks like a private key or an access key is left out too, and inside a committed patch such values are replaced with `[redacted]` so the surrounding code, test fixtures included, stays reviewable. The prompt lists what was omitted and what was redacted, before the change, and the rule not to fetch or quote them is stated outside the data block. Committed scopes always include the commit log, the diff stat, and the base, merge-base, and head SHAs.

A change of at most 256 KB and 40 files is inlined, untracked files included up to 512 KB each and 2 MB in total. A larger change is summarized instead and the patch is handed over one of two ways: a reviewer that can run git gets the file list and the exact `git diff` command per file; Claude in `read-only` mode, which cannot, gets per-file patch files and the whole diff written under the session's task directory to read with its file tools. Both routes come from the same filtered view, so an omitted file is omitted everywhere and a redacted file is flagged on the fetch list. Only the diff counts toward the inline threshold; untracked files have their own caps.

## The host double-checks before relaying

The skill tells the host agent to run `cite` on a finished job before relaying results. It prints every finding with the lines it cites, read from the reviewed revision for committed scopes and from the working tree for working scope, and marks anything it cannot resolve. The host classifies each finding as agree, disagree with evidence, nuance, false positive, or unverifiable, and relays that alongside the findings with their ids, so you can decide with `reject F-...` and friends. It is told to default to trusting a finding it cannot refute from the cited lines, since it may have written the code itself.

## Reviewer capabilities

The reviewer is the same agent you already trust to write code, so by default it can do whatever that agent can: run tests, write scratch code, install tools, download libraries, drive browsers, and call any MCP servers, hooks, and settings from your own Codex or Claude Code configuration. `--capability` selects the mode per review:

| Mode | Codex backend | Claude backend |
| --- | --- | --- |
| `full` (default) | no sandbox, approvals never | `--permission-mode bypassPermissions`, all tools |
| `workspace` | `workspace-write` sandbox with network: the checkout, `/tmp`, and scratch are writable, `.git` is protected, so no commits, stashes, or ref changes | same as `full` (Claude Code has no OS sandbox in headless mode) |
| `read-only` | `read-only` sandbox, approvals never | `--tools Read,Glob,Grep --permission-mode dontAsk --setting-sources user` |

Each session has a scratch directory at `<artifact directory>/<task>/scratch/`, already ignored by Git, which the prompt names as the only place inside the repository the reviewer may create files; it persists across review rounds so a test harness from round one is reusable. The prompt also tells the reviewer to leave the checkout as found: no edits to tracked files, no new files outside scratch, no git commands that change refs, the index, the stash, or the working tree, and never a commit or push. After the review the runtime compares HEAD, refs, the dirty set by content, newly ignored paths, and `.git` config and hooks with what it saw before, and reports any difference as a warning naming the paths, on the job, in the artifact, and in the rendered result, on success and failure alike. Ignored paths that already existed are not compared. If HEAD moved, the session keeps the pre-review HEAD as its last reviewed commit, so a stray commit can be undone without losing continuity. Explicit `--resume-session` reviews still fail on any change. In `full` and `workspace` the Claude backend behaves like a normal session in the reviewed repository, its `.claude/settings.json` hooks included; `read-only` loads only your user settings so a repository you do not trust cannot run hooks, and the reviewer runs with your own privileges and network in every mode.

## Develop

```sh
npm test
npm run validate
npm run smoke
```

`npm test` runs one suite, parametrized over both backends, against disposable Git repositories with fake `claude` and `codex` executables.

`npm run validate` checks the plugin against each host: `claude plugin validate --strict`, `agy plugin validate --strict`, and an install into a throwaway `CODEX_HOME`, since Codex has no validator. It needs all three CLIs, and it can start failing with no change here, because Antigravity's validator gains warnings between releases.

`npm run smoke` is opt-in and spends reviewer usage: it runs a review, a resumed re-review, `cite`, and an audit round with a rubric and a two-item checklist against the real `claude` and `codex` CLIs on a disposable repository at low effort. The audit round is the only check that each CLI accepts the schema a checklist extends. `npm run smoke -- codex` or `npm run smoke -- claude` runs one half. Its Codex half leaves a trust entry for the disposable repository in `~/.codex/config.toml`, which is safe to delete.

The runtime lives in `plugins/cross-review/skills/cross-review/scripts/runtime.mjs` with one backend module per reviewer in `scripts/backends/`, listed in the `cross-review.mjs` entry. All of it stays inside the plugin directory because hosts copy an installed plugin out of the repository. Any change under `plugins/` needs a version bump before it ships; see [Update](#update). Keep `SKILL.md` under 8,000 bytes, which `npm test` enforces: Codex's source cuts an injected skill off there. Where `.git/info/exclude` lists `.claude-*`, as this repository's author's Git template does, `git add` silently skips a new `.claude-plugin/` file, so add one with `git add -f`.

Verify an installed development build without starting a review:

```sh
claude -p --plugin-dir /absolute/path/to/cross-review/plugins/cross-review \
  'Use the cross-review skill to run only the bundled runtime help. Do not run a review. Report the absolute script path it ran.'

codex exec --ephemeral --sandbox read-only --cd /path/to/a/git/repository \
  'Use $cross-review to run only the bundled runtime help. Do not run a review. Report the absolute installed script path.'
```

The first should report a path inside the plugin directory and the second a path under Codex's plugin cache, both with output beginning with `Cross Review`.

## License

MIT, see [LICENSE](LICENSE). The review rubric text adapted from OpenAI Codex is under the Apache License 2.0, see [NOTICE](NOTICE).
