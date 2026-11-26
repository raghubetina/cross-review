// Behaviors that every fake reviewer shares, each switched on by an
// environment variable named with that fake's prefix, such as
// FAKE_CODEX_EXIT_EARLY.

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

// Exits before reading the prompt, as a CLI that rejects its options does.
export function exitEarly(prefix) {
  if (process.env[`${prefix}_EXIT_EARLY`] !== "1") return;
  process.stderr.write("fake reviewer rejected its options\n");
  process.exit(3);
}

// Starts a long-running helper in the reviewer's process group, as a test
// runner or a development server would, and records its PID.
export function startHelper(prefix) {
  const pidFile = process.env[`${prefix}_HELPER_PID_FILE`];
  if (!pidFile) return;
  // A helper in a session of its own is outside the reviewer's process group,
  // as a command that a CLI's shell tool starts can be. One that holds the
  // reviewer's output keeps the pipe open after the reviewer exits.
  const holdsOutput = process.env[`${prefix}_HELPER_HOLDS_OUTPUT`] === "1";
  const options = {
    stdio: holdsOutput ? ["ignore", "inherit", "inherit"] : "ignore",
    detached: holdsOutput || process.env[`${prefix}_HELPER_OWN_SESSION`] === "1"
  };
  // A helper that ignores SIGTERM stops only when the whole group is killed.
  const helper = process.env[`${prefix}_HELPER_IGNORES_TERM`] === "1"
    ? spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], options)
    : spawn("sleep", ["120"], options);
  helper.unref();
  fs.writeFileSync(pidFile, String(helper.pid), "utf8");
}

// Waits while the hold file exists, so a test can change the checkout while
// the reviewer is known to be running, then release it.
export async function hold(prefix) {
  const file = process.env[`${prefix}_HOLD_FILE`];
  if (!file) return;
  const deadline = Date.now() + 300_000;
  while (fs.existsSync(file) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
}

// Drops a top-level field from the result, as a reviewer whose CLI let an
// incomplete result through would.
export function omitField(prefix, structured) {
  const field = process.env[`${prefix}_OMIT_FIELD`];
  if (field) delete structured[field];
}

// Writes text in two pieces split inside its first multibyte character, as a
// pipe may deliver it.
export async function writeOutput(prefix, text) {
  const bytes = Buffer.from(text);
  const lead = bytes.findIndex((byte) => byte >= 0xc0);
  if (process.env[`${prefix}_SPLIT_UTF8`] !== "1" || lead < 0) {
    process.stdout.write(text);
    return;
  }
  await new Promise((resolve) => process.stdout.write(bytes.subarray(0, lead + 1), resolve));
  await new Promise((resolve) => setTimeout(resolve, 200));
  await new Promise((resolve) => process.stdout.write(bytes.subarray(lead + 1), resolve));
}

// Stages other content for a file and puts its working copy back, so only
// the index differs, as a reviewer's stray git add would leave it.
export function stageOnly(prefix, cwd) {
  const file = process.env[`${prefix}_STAGE_ONLY`];
  if (!file) return;
  const target = path.join(cwd, file);
  const original = fs.readFileSync(target);
  fs.writeFileSync(target, "staged by the reviewer\n");
  spawnSync("git", ["add", "--", file], { cwd });
  fs.writeFileSync(target, original);
}

// Changes the repository's shared configuration, as a stray git config would.
export function strayConfig(prefix, cwd) {
  if (process.env[`${prefix}_CONFIG`] === "1") spawnSync("git", ["config", "cross-review.stray", "1"], { cwd });
}

// What a fake returns for a research or brainstorm schema, since the real
// CLIs answer in whichever schema they are given; null for a review schema.
// A test can supply the claims or ideas as JSON.
export function researchResult(prefix, schema) {
  const properties = schema?.properties ?? {};
  const setting = (name) => process.env[`${prefix}_${name}`];
  if (properties.claims) {
    return {
      summary: "The fake researcher's answer.",
      claims: setting("CLAIMS") ? JSON.parse(setting("CLAIMS")) : [
        {
          id: null,
          statement: "The example file starts with the word first.",
          basis: "source",
          confidence: "high",
          sources: [{ url: null, file: "example.txt", quote: "first" }],
          note: "",
          responds_to: null,
          stance: "independent"
        }
      ],
      gaps: ["Whatever the fake researcher did not look at."],
      artifacts: []
    };
  }
  if (properties.ideas) {
    return {
      framing: "The fake generator's reading of the problem.",
      ideas: setting("IDEAS") ? JSON.parse(setting("IDEAS")) : ["Do the simple thing", "Do the opposite"].map((title, index) => ({
        id: null,
        title,
        description: `${title}, described.`,
        wins_when: "The simple case is the common one.",
        assumption: "The example file stays small.",
        test: "Measure it.",
        precedents: [],
        from_lens: index === 0,
        builds_on: []
      })),
      questions: ["Which constraint matters most?"]
    };
  }
  return null;
}
