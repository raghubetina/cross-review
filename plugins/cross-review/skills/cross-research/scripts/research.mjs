// Runtime for the cross-research skill. One thread is one topic; each round
// of a thread puts the same request to several researchers at once, each a
// seat with its own persistent conversation, and keeps what they return side
// by side so the agent that asked can compare and check it.
//
// A researcher is one of the review backends in ../../cross-review/scripts/
// backends/, run through adapters.mjs.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

import {
  CAPABILITIES,
  detectHost,
  nearMiss,
  parseReviewerOutput,
  readOptionFile,
  resolveRepository,
  reviewerEnvironment,
  schemaErrors,
  validateBackend
} from "../../cross-review/scripts/runtime.mjs";
import { adapterFor } from "./adapters.mjs";
import { checkSources } from "./check.mjs";
import { DEFAULT_IDEAS, LENSES, MODES, buildPrompt, schemaFor } from "./prompts.mjs";
import {
  atomicWriteJson,
  atomicWriteText,
  git,
  descendantsOf,
  groupGone,
  killProcesses,
  killTreeOf,
  mergeProcesses,
  processAlive,
  processStartTime,
  processVerified,
  readJson,
  removeInside,
  signalGroup,
  signalProcess,
  sleep,
  stopGroup,
  withLock
} from "./support.mjs";

let BACKENDS = {};
let SCRIPT_PATH = null;
// The repository this process works on, resolved once from --dir.
let REPO_ROOT = null;

// Where researchers keep their scratch work, the only state in the checkout.
export const ARTIFACT_DIRECTORY = "tmp/cross_research";
const STATE_VERSION = 1;
// Shared with the review runtime, so a reviewer cannot start research and a
// researcher cannot start a review.
const DEPTH = "CROSS_REVIEW_DEPTH";
const DEFAULT_CAPABILITY = "full";
const MAX_IDEAS = 30;
// setTimeout fires at once for a delay beyond 2^31 - 1 milliseconds.
const MAX_TIMEOUT_MINUTES = Math.floor((2 ** 31 - 1) / 60_000);
const DEFAULT_WAIT_MINUTES = 5;
const WAIT_POLL_INTERVAL_MS = 2_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const STATE_LOCK_WAIT_MS = 30_000;
const ROUND_LOCK_WAIT_MS = 30_000;
const QUEUED_WITHOUT_WORKER_MS = 30_000;
const CANCEL_WAIT_MS = 15_000;
const CANCEL_POLL_MS = 1_000;
// How long a researcher's output may stay open after its CLI has exited and
// its process group has been stopped, before what it printed is taken as all.
const DRAIN_MS = 5_000;
const DEFAULT_PRUNE_DAYS = 30;
const MAX_RAW_LINES = 400;
const START_COMMANDS = ["research", "brainstorm", "again"];
const COMMANDS = [...START_COMMANDS, "status", "result", "check", "cancel", "list", "prune", "help"];
const OTHER_NAMES_FOR_AGY = ["antigravity", "gemini"];

const THREAD_ID = /^T-[0-9a-f]{6}$/i;
const JOB_ID = /^research-[0-9a-z]+-[0-9a-f]{6}$/;
const ITEM_ID = /^[CI]-[0-9a-f]{6}$/i;
const SEAT_ID = /^[a-z]+(?:-[1-9][0-9]*)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A model or conversation id as a CLI receives it. One that starts with a
// dash would be read as an option.
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:@/+[\]-]{0,199}$/;
const STATUSES = ["queued", "running", "completed", "failed", "cancelled"];
const LEDGER_DISPOSITIONS = ["open", "accepted", "rejected", "parked", "pursued", "dropped"];
const ITEM_IDS = /[CI]-[0-9a-f]{6}/gi;
const DECISION_VERBS = ["accept", "reject", "pursue", "drop", "park", "reopen"];
const DECISION_ITEM = "`?[CI]-[0-9a-f]{6}`?";
// One decision per line: a verb, one or more ids, and an optional note.
const DECISION_LINE = new RegExp(
  `^\\s*(?:[-*]\\s+)?(${DECISION_VERBS.join("|")})\\s+(${DECISION_ITEM}(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+|\\s+)${DECISION_ITEM})*)(?:\\s*[:\\u2014\\u2013-]\\s*|\\s+|$)(.*)$`,
  "i"
);
const DECISION_SHAPED = new RegExp(`\\b(?:${DECISION_VERBS.join("|")})\\s+\`?[CI]-[0-9a-f]{6}\\b`, "i");
const DECISIONS_SHAPED = new RegExp(DECISION_SHAPED.source, "gi");
// A claim is accepted or rejected and an idea pursued or dropped, whichever
// of the two verbs the user reached for.
const DISPOSITIONS = {
  claim: { accept: "accepted", pursue: "accepted", reject: "rejected", drop: "rejected", park: "parked", reopen: "open" },
  idea: { accept: "pursued", pursue: "pursued", reject: "dropped", drop: "dropped", park: "parked", reopen: "open" }
};

function usage() {
  const backends = Object.values(BACKENDS);
  const efforts = backends.map((backend) => `${backend.name}: ${backend.effortLevels.join("|")} (default: ${backend.defaultEffort})`);
  const restricted = backends.filter((backend) => backend.capabilities).map((backend) => `; ${backend.name}: ${backend.capabilities.join("|")} only`);
  const notes = backends.flatMap((backend) => (backend.usageNote ? [` ${backend.usageNote}`] : []));
  const script = "cross-research.mjs";
  return `Cross Research

Researchers: ${Object.keys(BACKENDS).join(", ")}. Without --with, every researcher other than the agent running this takes part, except one that runs only when named.${notes.join("")}

Usage:
  ${script} research [-- question]
  ${script} brainstorm [-- problem]
  ${script} again [id] [-- follow-up and decisions]
  ${script} status [id] [--wait]
  ${script} result [id] [--wait] [--round <n>]
  ${script} check [id] [--round <n>] [--refresh]
  ${script} cancel [id]
  ${script} list
  ${script} prune [--older-than <days>]

An id is a job ID or a thread ID. Without one, the most recent job or thread is used.

Options:
  --dir <path>                 Repository the research is about (default: current directory)
  --with <names>               Researchers, comma-separated; a name may repeat for more seats of one kind
  --question-file <path>       Read the question or problem from this file
  --lens <text>                An angle for the next seat in order; repeat for more seats
  --no-lens                    Brainstorm without the built-in lenses
  --ideas <number>             Ideas each seat gives in a brainstorm (default: ${DEFAULT_IDEAS})
  --mode <mode>                With again, ${MODES.join("|")} for this round (default: the thread's last mode)
  --share                      With again, show each researcher the others' last results
  --no-share                   With again, keep the others' results from each researcher
  --model <name=model>         Model for one kind of researcher; a bare model when there is only one kind
  --effort <level>             For every seat, or <name=level> for one kind. ${efforts.join("; ")}
  --capability <mode>          ${CAPABILITIES.join("|")} (default: ${DEFAULT_CAPABILITY}${restricted.join("")})
  --timeout-minutes <number>   Hard limit for each researcher (default: none)
  --wait                       Run a round in the foreground; block status/result until the round ends
  --wait-minutes <number>      Longest a status or result --wait call blocks (default: ${DEFAULT_WAIT_MINUTES})
  --background                 Accepted for symmetry with cross-review; a round runs in the background anyway
  --round <number>             With result or check, an earlier round of the thread
  --refresh                    With check, fetch every source again
  --older-than <days>          With prune, the age of what it removes (default: ${DEFAULT_PRUNE_DAYS})
  -h, --help                   Show this help`;
}

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function positiveInteger(text, option, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${option} must be a whole number from 1 to ${maximum}; got ${text}.`);
  }
  return value;
}

function positiveNumber(text, option, maximum) {
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > maximum) throw new Error(`${option} must be a number above 0 and at most ${maximum}; got ${text}.`);
  return value;
}

// A value such as codex=high sets one kind of researcher; a bare value sets
// every seat.
function perResearcher(target, text, option) {
  const equals = text.indexOf("=");
  if (equals < 0) {
    target.all = text;
    return;
  }
  const name = text.slice(0, equals);
  const value = text.slice(equals + 1);
  if (!name || !value) throw new Error(`${option} ${text} needs both a researcher and a value, as in ${option} codex=<value>.`);
  target[name] = value;
}

export function parseArguments(argv) {
  const separator = argv.indexOf("--");
  const head = separator >= 0 ? argv.slice(0, separator) : argv;
  const tail = separator >= 0 ? argv.slice(separator + 1).join(" ").trim() : "";
  const options = {
    dir: process.cwd(),
    with: null,
    questionFile: null,
    lenses: [],
    noLens: false,
    ideas: null,
    mode: null,
    share: null,
    models: {},
    efforts: {},
    capability: null,
    timeoutMinutes: null,
    wait: false,
    waitMinutes: DEFAULT_WAIT_MINUTES,
    round: null,
    refresh: false,
    olderThanDays: null
  };
  const positional = [];
  for (let index = 0; index < head.length; index += 1) {
    const argument = head[index];
    const value = () => takeValue(head, index++, argument);
    if (argument === "-h" || argument === "--help") return { command: "help", id: null, text: "", options };
    if (argument === "--dir") options.dir = value();
    else if (argument === "--with") {
      const names = value().split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
      if (!names.length) throw new Error("--with names no researcher.");
      options.with = [...(options.with ?? []), ...names];
    }
    else if (argument === "--question-file") options.questionFile = value();
    else if (argument === "--lens") options.lenses.push(value());
    else if (argument === "--no-lens") options.noLens = true;
    else if (argument === "--ideas") options.ideas = positiveInteger(value(), argument, MAX_IDEAS);
    else if (argument === "--mode") {
      options.mode = value();
      if (!MODES.includes(options.mode)) throw new Error(`--mode must be ${MODES.join(" or ")}; got ${options.mode}.`);
    } else if (argument === "--share") options.share = true;
    else if (argument === "--no-share") options.share = false;
    else if (argument === "--model") perResearcher(options.models, value(), argument);
    else if (argument === "--effort") perResearcher(options.efforts, value(), argument);
    else if (argument === "--capability") {
      options.capability = value();
      if (!CAPABILITIES.includes(options.capability)) throw new Error(`--capability must be one of ${CAPABILITIES.join(", ")}; got ${options.capability}.`);
    } else if (argument === "--timeout-minutes") options.timeoutMinutes = positiveNumber(value(), argument, MAX_TIMEOUT_MINUTES);
    else if (argument === "--wait") options.wait = true;
    else if (argument === "--wait-minutes") options.waitMinutes = positiveNumber(value(), argument, MAX_TIMEOUT_MINUTES);
    else if (argument === "--background") continue;
    else if (argument === "--round") options.round = positiveInteger(value(), argument);
    else if (argument === "--refresh") options.refresh = true;
    else if (argument === "--older-than") options.olderThanDays = positiveNumber(value(), argument, 36_500);
    else if (argument.startsWith("--")) throw new Error(`Unknown option ${argument}. Put a question that starts with dashes after --.`);
    else positional.push(argument);
  }
  if (options.lenses.length && options.noLens) throw new Error("--lens and --no-lens cannot be combined.");

  const [command, ...rest] = positional;
  if (command === undefined) {
    if (tail) throw new Error(`Say what to do with that text: ${START_COMMANDS.join(", ")}.`);
    return { command: "help", id: null, text: "", options };
  }
  if (!COMMANDS.includes(command)) {
    const meant = nearMiss(command, COMMANDS);
    throw new Error(`Unknown command ${command}.${meant ? ` Did you mean ${meant}?` : ` Use one of: ${COMMANDS.filter((name) => name !== "help").join(", ")}.`}`);
  }
  if (command === "research" || command === "brainstorm") {
    return { command, id: null, text: [rest.join(" "), tail].filter(Boolean).join(" "), options };
  }
  const looksLikeId = (word) => THREAD_ID.test(word ?? "") || JOB_ID.test(word ?? "");
  if (command === "again") {
    const id = looksLikeId(rest[0]) ? rest[0] : null;
    return { command, id, text: [rest.slice(id ? 1 : 0).join(" "), tail].filter(Boolean).join(" "), options };
  }
  if (rest.length > (["list", "prune", "help"].includes(command) ? 0 : 1) || tail) {
    throw new Error(`${command} takes ${["list", "prune", "help"].includes(command) ? "no id" : "at most one id"} and no other text.`);
  }
  if (rest[0] !== undefined && !looksLikeId(rest[0])) throw new Error(`${rest[0]} is neither a job ID nor a thread ID.`);
  return { command, id: rest[0] ?? null, text: "", options };
}

function now() {
  return new Date().toISOString();
}

function canonicalThreadId(id) {
  return `T-${id.slice(2).toLowerCase()}`;
}

function canonicalItemId(id) {
  return `${id[0].toUpperCase()}-${id.slice(2).toLowerCase()}`;
}

// Where the records the runtime trusts are kept: under the Git directory,
// which a researcher confined to the workspace cannot write, and per worktree.
function stateRoot(repoRoot) {
  const gitPath = git(repoRoot, ["rev-parse", "--git-path", "cross-research"]).stdout.trim();
  return path.isAbsolute(gitPath) ? gitPath : path.resolve(repoRoot, gitPath);
}

const scratchBase = () => path.join(REPO_ROOT, ...ARTIFACT_DIRECTORY.split("/"));
const scratchRoot = (threadId) => path.join(scratchBase(), threadId);
const scratchDirectory = (threadId, seatId) => path.join(scratchRoot(threadId), seatId);

// Scratch directories are ignored through the repository's own exclude file
// unless something already ignores them, so they never show up as changes.
function ensureStateRoot(repoRoot) {
  const ignored = git(repoRoot, ["check-ignore", "-q", "--no-index", "--", `${ARTIFACT_DIRECTORY}/.probe`], { allowFailure: true }).status === 0;
  if (!ignored) {
    const gitPath = git(repoRoot, ["rev-parse", "--git-path", "info/exclude"]).stdout.trim();
    const excludePath = path.isAbsolute(gitPath) ? gitPath : path.resolve(repoRoot, gitPath);
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    if (!current.split(/\r?\n/).includes(`${ARTIFACT_DIRECTORY}/`)) {
      const prefix = current && !current.endsWith("\n") ? "\n" : "";
      fs.appendFileSync(excludePath, `${prefix}# Cross Research artifacts\n${ARTIFACT_DIRECTORY}/\n`, "utf8");
    }
  }
  const root = stateRoot(repoRoot);
  fs.mkdirSync(path.join(root, "jobs"), { recursive: true });
  fs.mkdirSync(path.join(root, "threads"), { recursive: true });
  return root;
}

const jobPath = (root, id) => path.join(root, "jobs", `${id}.json`);
const logPath = (root, id) => path.join(root, "jobs", `${id}.log`);
// A cancel request lives in its own file, so a worker saving its copy of the
// job can never overwrite it.
const cancelPath = (root, id) => path.join(root, "jobs", `${id}.cancel`);
const threadDirectory = (root, id) => path.join(root, "threads", id);
const threadPath = (root, id) => path.join(threadDirectory(root, id), "thread.json");
const roundDirectory = (root, threadId, round) => path.join(threadDirectory(root, threadId), `round-${round}`);
const seatFile = (root, job, seatId, suffix) => path.join(roundDirectory(root, job.thread_id, job.round), `${seatId}.${suffix}`);
const reportPath = (root, job) => path.join(threadDirectory(root, job.thread_id), `round-${job.round}.md`);
const checkPath = (root, job) => path.join(threadDirectory(root, job.thread_id), `round-${job.round}.check.json`);
const sourcesDirectory = (root, threadId) => path.join(threadDirectory(root, threadId), "sources");

// A cancel request is its own file, so a worker saving its copy of the job
// can never overwrite it, and it is written by renaming, which never writes
// through a link.
function requestCancelFile(root, id) {
  atomicWriteText(cancelPath(root, id), `${now()}\n`);
}

function cancelRequestedFor(root, id) {
  return fs.lstatSync(cancelPath(root, id), { throwIfNoEntry: false })?.isFile() ?? false;
}

function withStateLock(root, callback) {
  return withLock(path.join(root, ".state.lock"), callback, {
    waitMs: STATE_LOCK_WAIT_MS,
    busy: "Another cross-research command is still updating this repository's research records; try again in a moment."
  });
}

function saveJob(root, job) {
  job.updated_at = now();
  atomicWriteJson(jobPath(root, job.id), job);
}

function saveThread(root, thread) {
  thread.updated_at = now();
  atomicWriteJson(threadPath(root, thread.id), thread);
}

// Every record is read back before it decides anything, and a record that
// does not hold what the runtime wrote is treated as absent: a model or
// conversation id that a CLI would take for an option, a capability or a
// backend that the seat's id does not allow, a path that would lead out of
// where the runtime keeps things, or a number that a prompt would spell out.
const text = (value) => typeof value === "string";
const optionalSafe = (value) => value === null || value === undefined || (typeof value === "string" && SAFE_VALUE.test(value));
const backendOf = (seatId) => seatId.replace(/-[0-9]+$/, "");

function soundSettings(settings, backendName) {
  if (typeof backendName !== "string" || !Object.hasOwn(BACKENDS, backendName)) return false;
  const backend = BACKENDS[backendName];
  const lens = settings.lens;
  return (backend.capabilities ?? CAPABILITIES).includes(settings.capability)
    && backend.effortLevels.includes(settings.effort) && optionalSafe(settings.model)
    && (lens === null || lens === undefined || (typeof lens === "object" && text(lens.name) && text(lens.text)));
}

function soundSeat(seat) {
  return seat !== null && typeof seat === "object" && text(seat.id) && SEAT_ID.test(seat.id)
    && seat.backend === backendOf(seat.id) && soundSettings(seat, seat.backend)
    && text(seat.session_id) && UUID.test(seat.session_id) && optionalSafe(seat.conversation_id)
    && typeof seat.established === "boolean";
}

function soundRound(round, index, seatIds) {
  return round !== null && typeof round === "object" && round.number === index + 1 && MODES.includes(round.mode)
    && text(round.text) && typeof round.shared === "boolean"
    && Number.isInteger(round.ideas) && round.ideas >= 1 && round.ideas <= MAX_IDEAS
    && text(round.job_id) && JOB_ID.test(round.job_id) && Array.isArray(round.decisions)
    && Array.isArray(round.seats) && round.seats.length > 0 && round.seats.every((id) => seatIds.has(id));
}

function soundThread(thread, id) {
  if (!(thread?.version === STATE_VERSION && thread.id === id && THREAD_ID.test(id) && id === canonicalThreadId(id)
    && thread.repo_root === REPO_ROOT && MODES.includes(thread.mode) && text(thread.question)
    && Array.isArray(thread.seats) && thread.seats.every(soundSeat) && Array.isArray(thread.rounds)
    && thread.ledger !== null && typeof thread.ledger === "object" && !Array.isArray(thread.ledger))) return false;
  const seatIds = new Set(thread.seats.map((seat) => seat.id));
  return seatIds.size === thread.seats.length
    && thread.rounds.every((round, index) => soundRound(round, index, seatIds))
    && Object.entries(thread.ledger).every(([key, entry]) => entry?.id === key && ITEM_ID.test(key)
      && ["claim", "idea"].includes(entry.kind) && seatIds.has(entry.seat) && text(entry.text)
      && LEDGER_DISPOSITIONS.includes(entry.disposition));
}

function soundSeatState(state, seatId) {
  return state !== null && typeof state === "object" && STATUSES.includes(state.status)
    && state.backend === backendOf(seatId) && soundSettings(state, state.backend)
    && (state.pid === null || state.pid === undefined || Number.isInteger(state.pid))
    && (state.pid_started === null || state.pid_started === undefined || text(state.pid_started))
    && optionalSafe(state.conversation_id);
}

function soundJob(job, id) {
  return job?.version === STATE_VERSION && job.id === id && JOB_ID.test(id)
    && text(job.thread_id) && THREAD_ID.test(job.thread_id) && job.thread_id === canonicalThreadId(job.thread_id)
    && Number.isInteger(job.round) && job.round >= 1 && MODES.includes(job.mode) && STATUSES.includes(job.status)
    && job.repo_root === REPO_ROOT && (job.pid === null || Number.isInteger(job.pid))
    && (job.timeout_minutes === null || (typeof job.timeout_minutes === "number" && job.timeout_minutes > 0 && job.timeout_minutes <= MAX_TIMEOUT_MINUTES))
    && Array.isArray(job.seat_order) && job.seat_order.length > 0
    && job.seat_order.every((seatId) => text(seatId) && SEAT_ID.test(seatId) && soundSeatState(job.seats?.[seatId], seatId));
}

// A job counts only once its thread lists it as that round's job, so a round
// whose preparation stopped half way never reads as a round.
function listedJobs(threads) {
  return new Set(threads.flatMap((thread) => thread.rounds.map((round) => `${thread.id} ${round.number} ${round.job_id}`)));
}

function loadJobs(root) {
  const directory = path.join(root, "jobs");
  if (!fs.existsSync(directory)) return [];
  const listed = listedJobs(loadThreads(root));
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ id: name.slice(0, -".json".length), job: readJson(path.join(directory, name)) }))
    .filter(({ id, job }) => soundJob(job, id) && listed.has(`${job.thread_id} ${job.round} ${job.id}`))
    .map(({ job }) => job)
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
}

function loadThreads(root) {
  const directory = path.join(root, "threads");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .map((name) => ({ id: name, thread: readJson(threadPath(root, name)) }))
    .filter(({ id, thread }) => soundThread(thread, id))
    .map(({ thread }) => thread)
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
}

function loadThread(root, id) {
  const thread = readJson(threadPath(root, id));
  if (!soundThread(thread, id)) throw new Error(`Research thread not found, or its record is not one this runtime wrote: ${id}`);
  return thread;
}

// A job by its ID, read again from disk and held to the same standard.
function loadJob(root, id) {
  const job = readJson(jobPath(root, id));
  if (!soundJob(job, id)) return null;
  const thread = readJson(threadPath(root, job.thread_id));
  return soundThread(thread, job.thread_id) && listedJobs([thread]).has(`${job.thread_id} ${job.round} ${job.id}`) ? job : null;
}

// A seat's saved result, used only if it is the one this job's seat wrote and
// still has the shape the schema requires, with an id on every item.
function loadResult(root, job, seatId) {
  const result = readJson(seatFile(root, job, seatId, "json"));
  if (!(result?.version === STATE_VERSION && result.job_id === job.id && result.thread_id === job.thread_id
    && result.round === job.round && result.seat === seatId && result.mode === job.mode
    && optionalSafe(result.conversation_id))) return null;
  if (result.structured === null) return result;
  if (schemaErrors(result.structured, schemaFor(result.mode)).length) return null;
  const items = result.mode === "brainstorm" ? result.structured.ideas : result.structured.claims;
  return items.every((item) => text(item.id) && ITEM_ID.test(item.id)) ? result : null;
}

// The job an id names: a job ID names itself, and a thread ID its latest
// round, or the round asked for.
function chooseJob(root, id, round = null) {
  const jobs = loadJobs(root);
  let chosen;
  if (!id) {
    chosen = jobs[0];
    if (!chosen) throw new Error("No cross-research jobs found for this repository.");
  } else if (THREAD_ID.test(id)) {
    chosen = jobs.find((job) => job.thread_id === canonicalThreadId(id));
    if (!chosen) throw new Error(`Research thread not found: ${id}`);
  } else {
    chosen = jobs.find((job) => job.id === id);
    if (!chosen) throw new Error(`Research job not found: ${id}`);
  }
  if (round === null || round === chosen.round) return chosen;
  const earlier = jobs.find((job) => job.thread_id === chosen.thread_id && job.round === round);
  if (!earlier) throw new Error(`Research thread ${chosen.thread_id} has no round ${round}.`);
  return earlier;
}

function newId(prefix, taken) {
  for (;;) {
    const id = `${prefix}-${crypto.randomBytes(3).toString("hex")}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

export function parseDecisions(text) {
  const decisions = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.match(DECISION_LINE);
    if (!match) continue;
    const note = match[3].trim() || null;
    for (const id of match[2].match(ITEM_IDS)) decisions.push({ id: canonicalItemId(id), verb: match[1].toLowerCase(), note });
  }
  return decisions;
}

// Records the decisions in the round's text on the thread's ledger, and says
// which were recorded and which were not, so that a decision the user believes
// they made is never dropped in silence.
function applyDecisions(thread, text, round) {
  const recorded = [];
  const unknown = [];
  for (const decision of parseDecisions(text)) {
    const entry = thread.ledger[decision.id];
    if (!entry) {
      unknown.push(decision.id);
      continue;
    }
    entry.disposition = DISPOSITIONS[entry.kind][decision.verb];
    entry.note = decision.note;
    entry.decided_round = round;
    recorded.push({ id: entry.id, disposition: entry.disposition, note: entry.note });
  }
  const warnings = [];
  if (unknown.length) warnings.push(`This thread has no ${[...new Set(unknown)].join(", ")}, so no decision was recorded for ${unknown.length === 1 ? "it" : "them"}.`);
  const unread = unreadDecisionPhrases(text);
  if (unread) {
    warnings.push(`${unread} phrase(s) that look like decisions were not recorded. Put each decision on its own line, as in "pursue I-1a2b3c: reason".`);
  }
  return { recorded, warnings };
}

// The decision-shaped phrases the parser did not read: every one on a line it
// did not read as a decision, and every one after the first on a line it did.
function unreadDecisionPhrases(text) {
  let unread = 0;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const phrases = (line.match(DECISIONS_SHAPED) ?? []).length;
    unread += DECISION_LINE.test(line) ? Math.max(0, phrases - 1) : phrases;
  }
  return unread;
}

function binaryOf(backend) {
  return process.env[backend.binaryEnv] || backend.defaultBinary;
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function checkVersion(backend) {
  const binary = binaryOf(backend);
  const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") throw new Error(`${backend.versionLabel} is not installed, or ${binary} is not on PATH. ${backend.installHint}`);
  if (result.error || result.status !== 0) throw new Error(`Unable to run ${backend.versionLabel} at ${binary}. ${backend.installHint}`);
  const match = `${result.stdout}\n${result.stderr}`.match(/(\d+)\.(\d+)\.(\d+)/);
  const version = match ? match.slice(1, 4).map(Number) : null;
  if (!version || !versionAtLeast(version, backend.minVersion)) {
    throw new Error(`${backend.versionLabel} ${backend.minVersion.join(".")} or newer is required; found ${version?.join(".") ?? "an unknown version"}.`);
  }
  return version.join(".");
}

function validateResearcherNames(names) {
  for (const name of names) {
    if (Object.hasOwn(BACKENDS, name)) continue;
    if (OTHER_NAMES_FOR_AGY.includes(name)) throw new Error(`There is no ${name} researcher. Use agy.`);
    const meant = nearMiss(name, Object.keys(BACKENDS));
    throw new Error(`There is no ${name} researcher.${meant ? ` Did you mean ${meant}?` : ` Use ${Object.keys(BACKENDS).join(", ")}.`}`);
  }
}

// Without --with, everyone but the agent running this, which does its own
// research in its own conversation, and but a researcher that must be named.
function defaultPanel(env) {
  const host = detectHost(env);
  const names = Object.keys(BACKENDS).filter((name) => name !== host && !BACKENDS[name].explicitOnly);
  if (!names.length) throw new Error(`There is no researcher other than the agent running this. Name one with --with: ${Object.keys(BACKENDS).join(", ")}.`);
  return names;
}

function effortFor(options, backend, current = null) {
  const effort = options.efforts[backend.name] ?? options.efforts.all ?? current ?? backend.defaultEffort;
  if (!backend.effortLevels.includes(effort)) {
    throw new Error(`${backend.reviewerLabel} has no effort level ${effort}; its levels are ${backend.effortLevels.join(", ")}. Give it its own with --effort ${backend.name}=<level>.`);
  }
  return effort;
}

function capabilityFor(options, backend, current = null) {
  const capabilities = backend.capabilities ?? CAPABILITIES;
  const wanted = options.capability ?? current ?? DEFAULT_CAPABILITY;
  return capabilities.includes(wanted) ? wanted : capabilities[0];
}

function validateOverrides(options, seats) {
  for (const [name, model] of Object.entries(options.models)) {
    if (!SAFE_VALUE.test(model)) throw new Error(`--model ${name === "all" ? model : `${name}=${model}`} is not a model name: it must start with a letter or digit and hold no spaces.`);
  }
  const kinds = new Set(seats.map((seat) => seat.backend));
  for (const [option, values] of [["--model", options.models], ["--effort", options.efforts]]) {
    for (const name of Object.keys(values)) {
      if (name !== "all" && !kinds.has(name)) throw new Error(`${option} ${name}=${values[name]} names a researcher that is not taking part in this round.`);
    }
  }
  if (options.models.all && kinds.size > 1) {
    throw new Error(`With more than one kind of researcher, say which one a model is for, as in --model ${[...kinds][0]}=${options.models.all}.`);
  }
}

function newSeat(name, options, taken) {
  const backend = BACKENDS[name];
  let id = name;
  for (let count = 2; taken.has(id); count += 1) id = `${name}-${count}`;
  taken.add(id);
  return {
    id,
    backend: name,
    lens: null,
    model: options.models[name] ?? options.models.all ?? null,
    effort: effortFor(options, backend),
    capability: capabilityFor(options, backend),
    // The backends key some of their own state by this, such as the directory agy starts in.
    session_id: crypto.randomUUID(),
    conversation_id: null,
    established: false
  };
}

// Lenses go to new seats in order: the user's own first, and in a brainstorm
// the built-in ones after them, continuing from the seats the thread has.
function assignLenses(seats, options, mode, offset) {
  if (options.lenses.length > seats.length) {
    throw new Error(`${options.lenses.length} lenses were given for ${seats.length} new seat(s). Name more researchers with --with; a name may repeat.`);
  }
  seats.forEach((seat, index) => {
    if (index < options.lenses.length) seat.lens = { name: `lens ${offset + index + 1}`, text: options.lenses[index] };
    else if (mode === "brainstorm" && !options.noLens && !options.lenses.length) seat.lens = LENSES[(offset + index) % LENSES.length];
  });
}

function refuseHere(env) {
  if (env[DEPTH]) throw new Error("This is already running inside a cross-review reviewer or researcher, which cannot start research.");
  if (env.CODEX_SANDBOX_NETWORK_DISABLED === "1") {
    throw new Error("Codex's sandbox has no network access, so no researcher could reach its API or the web. Run Codex with network access, for example --sandbox danger-full-access.");
  }
}

function refuseSeats(seats, env) {
  for (const name of new Set(seats.map((seat) => seat.backend))) {
    const refusal = BACKENDS[name].refusal?.(env);
    if (refusal) throw new Error(refusal.replaceAll("reviewer", "researcher"));
    // Before anything is recorded, so a missing CLI fails here and not in a background worker.
    checkVersion(BACKENDS[name]);
  }
}

function jobActive(job) {
  return ["queued", "running"].includes(job?.status);
}

function seatActive(state) {
  return ["queued", "running"].includes(state?.status);
}

function workerGone(job) {
  if (!jobActive(job)) return false;
  if (job.pid) return !processAlive(job.pid, job.pid_started ?? null);
  return job.status === "queued" && Date.now() - Date.parse(job.updated_at ?? job.created_at ?? 0) > QUEUED_WITHOUT_WORKER_MS;
}

// Every claim and idea the thread's earlier rounds returned, by id, with the
// seat that returned it.
function loadItems(root, thread, beforeRound) {
  const items = new Map();
  for (const round of thread.rounds) {
    if (round.number >= beforeRound) continue;
    const job = { id: round.job_id, thread_id: thread.id, round: round.number, mode: round.mode };
    for (const seatId of round.seats) {
      const result = loadResult(root, job, seatId);
      if (!result?.structured) continue;
      const kind = result.mode === "brainstorm" ? "idea" : "claim";
      for (const item of kind === "idea" ? result.structured.ideas : result.structured.claims) {
        items.set(item.id, { kind, seat: seatId, round: round.number, item });
      }
    }
  }
  return items;
}

// What a seat is shown of the thread so far: its own earlier output when its
// conversation cannot be resumed, the user's decisions, the ideas being
// pursued, and, when the round shares, what the others returned.
function seatContext(thread, round, seat, items) {
  const entries = Object.values(thread.ledger);
  const own = (entry) => entry.seat === seat.id;
  const decisions = entries.filter((entry) => entry.disposition !== "open")
    .map((entry) => ({ id: entry.id, disposition: entry.disposition, note: entry.note, text: entry.text, seat: entry.seat, own: own(entry) }));
  const ideas = [...items.values()].filter((entry) => entry.kind === "idea");
  const describe = (entry) => ({
    id: entry.item.id,
    seat: entry.seat,
    own: entry.seat === seat.id,
    disposition: thread.ledger[entry.item.id]?.disposition ?? "open",
    title: entry.item.title,
    description: entry.item.description,
    assumption: entry.item.assumption,
    test: entry.item.test
  });
  const latestRound = (seatId) => Math.max(...[...items.values()].filter((entry) => entry.kind === "claim" && entry.seat === seatId).map((entry) => entry.round));
  const others = [...new Set([...items.values()].filter((entry) => entry.kind === "claim" && entry.seat !== seat.id).map((entry) => entry.seat))];
  return {
    own: entries.filter(own).map((entry) => ({ id: entry.id, text: entry.text })),
    decisions,
    pursued: round.mode === "research" ? ideas.map(describe).filter((idea) => idea.disposition === "pursued") : [],
    shared: round.mode === "research" && round.shared
      ? others.map((seatId) => ({
        seat: seatId,
        claims: [...items.values()].filter((entry) => entry.kind === "claim" && entry.seat === seatId && entry.round === latestRound(seatId)).map((entry) => entry.item)
      }))
      : [],
    pool: round.mode === "brainstorm" && round.shared ? ideas.map(describe) : []
  };
}

function conductFor(writes, scratch, others, records) {
  const apart = `Other researchers work on this thread at the same time, and what they leave is under ${others}. Do not read their work there, or the runtime's records under ${records}, so that yours stays independent of theirs.`;
  if (!writes) return `Leave the repository exactly as you found it, and write no files anywhere. ${apart}`;
  return `Do all scratch work under ${scratch}, which persists across the rounds of this thread: clones, downloads, and experiments. Leave the repository itself exactly as you found it: do not modify tracked files, do not create files outside that scratch directory, and never commit or push. ${apart}`;
}

// Gives every claim or idea an id the user can decide on. An id the seat
// returned stands only if it names that seat's own earlier item of the same
// kind; a reference to another item stands only if the thread has it.
function identify(structured, mode, seat, ledger, taken) {
  const kind = mode === "brainstorm" ? "idea" : "claim";
  const used = new Set();
  const known = (id) => (typeof id === "string" && ITEM_ID.test(id.trim()) && ledger[canonicalItemId(id.trim())] ? canonicalItemId(id.trim()) : null);
  const identified = (item) => {
    const given = known(item.id);
    const own = given && ledger[given].seat === seat.id && ledger[given].kind === kind && !used.has(given);
    const id = own ? given : newId(kind === "idea" ? "I" : "C", taken);
    used.add(id);
    return id;
  };
  const cleanSources = (sources) => sources.map((source) => ({
    url: source.url?.trim() || null,
    file: source.url?.trim() ? null : source.file?.trim() || null,
    quote: source.quote
  }));
  if (kind === "idea") {
    return {
      ...structured,
      ideas: structured.ideas.map((idea) => ({
        ...idea,
        id: identified(idea),
        precedents: cleanSources(idea.precedents),
        builds_on: [...new Set(idea.builds_on.map(known).filter(Boolean))]
      }))
    };
  }
  return {
    ...structured,
    claims: structured.claims.map((claim) => {
      const respondsTo = known(claim.responds_to);
      return {
        ...claim,
        id: identified(claim),
        sources: cleanSources(claim.sources),
        responds_to: respondsTo,
        stance: respondsTo ? claim.stance : "independent"
      };
    })
  };
}

// Worker state: the researchers this process is running, and whether a cancel
// has arrived. Set by the SIGTERM and SIGINT handlers.
const activeChildren = new Set();
let cancelRequested = false;

// A round has no deadline by default, so stopping one must not depend on the
// researcher honoring SIGTERM. The whole process group is signalled, so the
// tools the researcher started stop with it.
function stopChild(child) {
  // Listed while the CLI is still there to ask, since a command it started
  // in a session of its own is outside its process group. A later stop adds
  // to what an earlier one found and keeps its deadline.
  child.below = mergeProcesses(child.below, descendantsOf(child.pid));
  signalGroup(child.pid, "SIGTERM");
  child.escalation ??= setTimeout(() => {
    child.below = mergeProcesses(child.below, descendantsOf(child.pid));
    signalGroup(child.pid, "SIGKILL");
    killProcesses(child.below);
  }, 5_000).unref();
}

// Stops every researcher this worker runs, however the cancel arrived.
function requestCancel() {
  cancelRequested = true;
  for (const child of activeChildren) stopChild(child);
}

function lingeringGroupNote(pid) {
  return ` A process that the researcher started was still running afterwards; find it with ps -g ${pid}.`;
}

function invokeSeat({ backend, binary, args, cwd, env, cleanup, prompt, lastMessagePath, timeoutMinutes, onSpawn, onConversation }) {
  const label = backend.reviewerLabel;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    activeChildren.add(child);
    // Decoded as a stream, so a character split across two reads stays whole.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let stdinError = null;
    let timedOut = false;
    let oversized = false;
    let settled = false;
    let timer = null;
    let scanned = 0;
    let conversationReported = typeof backend.earlyConversationId !== "function";
    let resultSeen = typeof backend.isTerminalEvent !== "function";
    let graceTimer = null;
    let drainTimer = null;
    let heldOpen = false;
    let stoppedAfterResult = false;
    const stopAfterResult = () => {
      stoppedAfterResult = true;
      stopChild(child);
      // A helper process holding the pipes open would otherwise keep "close" from firing.
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, 6_000).unref();
    };
    const scanNewLines = () => {
      let newline;
      while ((!conversationReported || !resultSeen) && (newline = stdout.indexOf("\n", scanned)) >= 0) {
        const line = stdout.slice(scanned, newline).trim();
        scanned = newline + 1;
        if (!resultSeen && backend.isTerminalEvent(line)) {
          resultSeen = true;
          graceTimer = setTimeout(stopAfterResult, backend.resultGraceMs);
        }
        if (conversationReported) continue;
        const conversationId = backend.earlyConversationId(line);
        if (!conversationId) continue;
        conversationReported = true;
        try {
          onConversation(conversationId);
        } catch {
          // Recording the conversation early is best-effort; the seat's result records it authoritatively.
        }
      }
    };
    const clearInvocation = () => {
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (drainTimer) clearTimeout(drainTimer);
      activeChildren.delete(child);
      cleanup?.();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearInvocation();
      reject(error);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      clearInvocation();
      resolve(value);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      stdoutBytes += Buffer.byteLength(chunk);
      scanNewLines();
      if (!oversized && stdoutBytes > MAX_OUTPUT_BYTES) {
        oversized = true;
        stopChild(child);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(-MAX_OUTPUT_BYTES);
    });
    // A researcher that exits before reading the whole prompt closes the pipe;
    // its exit status and stderr, read on close, say why.
    child.stdin.on("error", (error) => {
      stdinError = error;
    });
    child.on("error", fail);
    // Whatever the researcher left running is stopped as soon as it exits,
    // whichever way its seat ends: a helper holding the pipes open would keep
    // "close" from firing, and one left behind could not be stopped later.
    let groupStopped = null;
    child.on("exit", () => {
      // The deadline was for the researcher, which has met it; stopping what
      // it left behind may take longer and must not turn its result into a timeout.
      if (timer) clearTimeout(timer);
      if (!child.pid) return;
      // From here the group is stopped by stopGroup, which checks that it is
      // gone, so the timed escalation has nothing left to do.
      clearTimeout(child.escalation);
      // Something the researcher started outside its group may still hold
      // its output open, which would keep "close" from ever firing, so what
      // it printed by a moment after the group is stopped is all there is.
      groupStopped = stopGroup(child.pid).then((gone) => {
        if (settled) return gone;
        drainTimer = setTimeout(() => {
          heldOpen = true;
          child.stdout.destroy();
          child.stderr.destroy();
        }, DRAIN_MS);
        return gone;
      });
      // What a stopped CLI did not take down with it.
      killProcesses(child.below ?? []);
    });
    child.on("close", (code, signal) => {
      if (!child.pid) return;
      void (groupStopped ?? stopGroup(child.pid)).then((gone) => {
        const held = heldOpen ? ` Something ${label} started kept its output open after it exited, so the runtime stopped reading ${DRAIN_MS / 1000} seconds later.` : "";
        const lingering = `${gone ? "" : lingeringGroupNote(child.pid)}${held}`;
        // A cancel outranks a result the researcher already printed.
        if (cancelRequested) return fail(new Error(`Cancelled by user.${lingering}`));
        if (timedOut) return fail(new Error(`${label} timed out after ${timeoutMinutes} minute(s).${lingering}`));
        if (oversized) return fail(new Error(`${label} output exceeded the 32 MB safety limit.${lingering}`));
        if (code !== 0 && !stoppedAfterResult) {
          const detail = stderr.trim() || stdout.trim();
          return fail(new Error(`${label} failed (exit ${code ?? signal})${detail ? `: ${detail.slice(-4000)}` : "."}${lingering}`));
        }
        if (stdinError && !stoppedAfterResult) return fail(new Error(`${label} exited before reading the whole prompt: ${stdinError.message}${lingering}`));
        let lastMessage = null;
        if (backend.usesLastMessageFile && fs.lstatSync(lastMessagePath, { throwIfNoEntry: false })?.isFile()) {
          try {
            lastMessage = fs.readFileSync(lastMessagePath, "utf8");
          } catch {
            // The last message is written only when a turn completes; the event stream is the fallback.
          }
        }
        return succeed({ stdout, stderr, lastMessage, lingering });
      });
    });
    try {
      onSpawn(child);
    } catch (error) {
      // A researcher whose PID was never recorded could not be stopped later.
      child.stdin.destroy();
      signalGroup(child.pid, "SIGKILL");
      fail(error);
      return;
    }
    if (cancelRequested) stopChild(child);
    if (timeoutMinutes) {
      timer = setTimeout(() => {
        timedOut = true;
        stopChild(child);
      }, timeoutMinutes * 60 * 1000);
    }
    child.stdin.end(prompt);
  });
}

async function runSeat(root, job, thread, round, seat, { items, taken }) {
  const state = job.seats[seat.id];
  const backend = BACKENDS[seat.backend];
  const adapter = adapterFor(backend);
  const schema = schemaFor(round.mode);
  const file = (suffix) => seatFile(root, job, seat.id, suffix);
  // A seat that never starts keeps its conversation, so a cancel that came in
  // before it is honored before anything else.
  if (cancelRequested) throw new Error("Cancelled by user.");
  const refusal = backend.refusal?.(process.env);
  if (refusal) throw new Error(refusal.replaceAll("reviewer", "researcher"));
  state.cli_version = checkVersion(backend);

  const scratch = scratchDirectory(thread.id, seat.id);
  const writes = adapter.writes(state.capability);
  if (writes) fs.mkdirSync(scratch, { recursive: true });
  const resumed = Boolean(seat.established && seat.conversation_id);
  const session = {
    session_id: seat.session_id,
    conversation_id: resumed ? seat.conversation_id : backend.conversationStrategy === "chosen" ? crypto.randomUUID() : null
  };
  // The shape the backends read a review job in.
  const view = {
    id: job.id,
    repo_root: job.repo_root,
    session_id: seat.session_id,
    effort: state.effort,
    model: state.model,
    capability: state.capability,
    resumed,
    backend_options: {}
  };
  const prompt = buildPrompt({
    mode: round.mode,
    threadMode: thread.mode,
    repoRoot: job.repo_root,
    question: thread.question,
    followUp: round.number > 1 ? round.text : null,
    round: round.number,
    resumed,
    lens: state.lens,
    ideas: round.ideas,
    tools: adapter.tools(state.capability),
    conduct: conductFor(writes, scratch, scratchRoot(thread.id), root),
    ...seatContext(thread, round, seat, items)
  });
  atomicWriteText(file("prompt.md"), prompt);
  atomicWriteText(file("schema.json"), `${JSON.stringify(schema, null, 2)}\n`);
  fs.rmSync(file("last-message.txt"), { force: true });
  const args = adapter.args(
    backend.buildArgs({ job: view, session, schema, schemaPath: file("schema.json"), lastMessagePath: file("last-message.txt"), capability: state.capability }),
    state.capability
  );
  const environment = reviewerEnvironment();
  const spawnOptions = backend.spawnOptions?.({ job: view, env: environment }) ?? {};

  if (cancelRequestedFor(root, job.id)) requestCancel();
  if (cancelRequested) throw new Error("Cancelled by user.");
  Object.assign(state, { status: "running", started_at: now(), resumed, conversation_id: session.conversation_id });
  saveJob(root, job);
  const invocation = await invokeSeat({
    backend,
    binary: binaryOf(backend),
    args,
    cwd: spawnOptions.cwd ?? job.repo_root,
    env: spawnOptions.env ?? environment,
    cleanup: spawnOptions.cleanup,
    prompt,
    lastMessagePath: file("last-message.txt"),
    timeoutMinutes: job.timeout_minutes,
    onSpawn: (child) => {
      state.pid = child.pid;
      state.pid_started = processStartTime(child.pid);
      saveJob(root, job);
    },
    onConversation: (conversationId) => {
      if (!SAFE_VALUE.test(conversationId)) return;
      state.conversation_id = conversationId;
      saveJob(root, job);
    }
  });
  atomicWriteText(file("events.log"), invocation.stdout);
  const parsed = parseReviewerOutput(invocation, backend, schema);
  const structured = parsed.structured ? identify(parsed.structured, round.mode, seat, thread.ledger, taken) : null;
  const result = {
    version: STATE_VERSION,
    job_id: job.id,
    thread_id: thread.id,
    round: round.number,
    mode: round.mode,
    seat: seat.id,
    backend: seat.backend,
    lens: state.lens,
    conversation_id: conversationAfter(parsed.conversationId, session.conversation_id),
    usage: parsed.usage,
    models: parsed.models,
    activity: adapter.activity(invocation.stdout),
    started_at: state.started_at,
    completed_at: now(),
    degraded: parsed.degraded,
    schema_errors: parsed.schemaErrors,
    raw: parsed.degraded ? parsed.rawResult : null,
    structured,
    warning: invocation.lingering.trim() || null
  };
  // The result file is what says a seat finished: the job's record of it
  // follows, and a worker that dies in between loses nothing.
  atomicWriteJson(file("json"), result);
  Object.assign(state, completedState(result));
  saveJob(root, job);
}

// The conversation a seat resumes next round. One the CLI reports is kept
// only if a later launch could pass it on safely, and otherwise the next round
// starts afresh; when the CLI reports none, it is the one the seat ran in.
export function conversationAfter(reported, ran) {
  if (reported !== null && reported !== undefined) return typeof reported === "string" && SAFE_VALUE.test(reported) ? reported : null;
  return typeof ran === "string" && SAFE_VALUE.test(ran) ? ran : null;
}

function completedState(result) {
  const items = result.structured ? (result.mode === "brainstorm" ? result.structured.ideas : result.structured.claims) : [];
  return {
    status: "completed",
    completed_at: result.completed_at,
    pid: null,
    error: null,
    conversation_id: result.conversation_id,
    degraded: result.degraded,
    count: items.length,
    warning: result.warning
  };
}

// Carries a round's outcome onto its thread: each seat's conversation, to
// resume or to give up, and every new claim and idea. It runs under the state
// lock and records each round once.
function settleLocked(root, job) {
  const thread = loadThread(root, job.thread_id);
  const round = thread.rounds.find((entry) => entry.number === job.round);
  if (round.settled_at) return;
  for (const seatId of job.seat_order) {
    const state = job.seats[seatId];
    const seat = thread.seats.find((entry) => entry.id === seatId);
    const result = state.status === "completed" ? loadResult(root, job, seatId) : null;
    if (!result) {
      // A seat that started and did not finish may have left its conversation
      // half-way through a turn, so its next round starts a new one and is
      // told what the seat returned before. A seat that never started keeps
      // the conversation it had.
      if (state.started_at) Object.assign(seat, { conversation_id: null, established: false });
      continue;
    }
    seat.conversation_id = result.conversation_id ?? null;
    seat.established = Boolean(seat.conversation_id);
    if (!result.structured) continue;
    const kind = result.mode === "brainstorm" ? "idea" : "claim";
    for (const item of kind === "idea" ? result.structured.ideas : result.structured.claims) {
      const text = kind === "idea" ? item.title : item.statement;
      const existing = thread.ledger[item.id];
      thread.ledger[item.id] = existing
        ? { ...existing, text, revised_round: round.number }
        : { id: item.id, kind, seat: seatId, round: round.number, text, disposition: "open", note: null, decided_round: null };
    }
  }
  round.settled_at = now();
  saveThread(root, thread);
}

// Ends a round under the state lock. The thread is settled and the report
// written before the job reads as terminal, and all of it in one hold of the
// lock, so nothing can claim, recover, or follow a round that is half ended.
function concludeLocked(root, job, cancelled) {
  settleLocked(root, job);
  const completed = job.seat_order.filter((seatId) => job.seats[seatId].status === "completed").length;
  Object.assign(job, {
    status: cancelled ? "cancelled" : completed ? "completed" : "failed",
    error: cancelled ? "Cancelled by user." : completed ? null : "No researcher finished; each seat says why.",
    completed_at: now(),
    pid: null
  });
  atomicWriteText(reportPath(root, job), `${renderJob(root, job, true)}\n`);
  saveJob(root, job);
  return job;
}

function endSeats(job, status, error) {
  for (const seatId of job.seat_order) {
    if (seatActive(job.seats[seatId])) Object.assign(job.seats[seatId], { status, error, completed_at: now() });
  }
}

function claimJob(root, job) {
  return withStateLock(root, () => {
    const current = loadJob(root, job.id);
    if (!current) return null;
    // A job that ended before this worker got to it, as one cancel settled, is shown as it ended.
    if (current.status !== "queued") return jobActive(current) ? null : { settled: current };
    if (cancelRequested || cancelRequestedFor(root, job.id)) {
      endSeats(current, "cancelled", "Cancelled by user.");
      return { settled: concludeLocked(root, current, true) };
    }
    Object.assign(job, current, { status: "running", started_at: now(), pid: process.pid, pid_started: processStartTime(process.pid) });
    saveJob(root, job);
    return { claimed: job };
  });
}

async function executeRound(root, job) {
  const lock = path.join(threadDirectory(root, job.thread_id), ".round.lock");
  const busy = `Another round of research thread ${job.thread_id} is still running.`;
  try {
    return await runLocked(root, job, lock, busy);
  } catch (error) {
    if (error.message !== busy) throw error;
    // Interrupted while it waited, the round was cancelled before it began;
    // and a job that a cancel settled meanwhile is shown as it ended.
    const settled = await withStateLock(root, () => {
      const current = loadJob(root, job.id);
      if (current?.status !== "queued" || !(cancelRequested || cancelRequestedFor(root, job.id))) return current;
      endSeats(current, "cancelled", "Cancelled by user.");
      return concludeLocked(root, current, true);
    });
    if (settled && !jobActive(settled)) return settled;
    throw error;
  }
}

function runLocked(root, job, lock, busy) {
  // A follow-up is admitted once the round before it reads as terminal, which
  // is a moment before that round's worker lets go of this lock, so the wait
  // is for a worker that is already leaving.
  return withLock(lock, async () => {
    const claim = await claimJob(root, job);
    if (!claim) throw new Error(`Research job ${job.id} is no longer queued, so there is nothing to run.`);
    if (claim.settled) return claim.settled;
    const thread = loadThread(root, job.thread_id);
    const round = thread.rounds.find((entry) => entry.number === job.round);
    const shared = { items: loadItems(root, thread, round.number), taken: new Set(Object.keys(thread.ledger)) };
    // A cancel whose signal never came, because whoever asked for it stopped
    // after writing its marker, is found here instead.
    const watch = setInterval(() => {
      if (!cancelRequested && cancelRequestedFor(root, job.id)) requestCancel();
    }, CANCEL_POLL_MS);
    try {
      await Promise.all(job.seat_order.map(async (seatId) => {
        try {
          await runSeat(root, job, thread, round, thread.seats.find((seat) => seat.id === seatId), shared);
        } catch (error) {
          // One researcher's failure is its seat's outcome; the others carry on.
          Object.assign(job.seats[seatId], { status: cancelRequested ? "cancelled" : "failed", error: error.message, completed_at: now(), pid: null });
          saveJob(root, job);
        }
      }));
    } finally {
      clearInterval(watch);
    }
    return withStateLock(root, () => concludeLocked(root, job, cancelRequested || cancelRequestedFor(root, job.id)));
  }, { waitMs: ROUND_LOCK_WAIT_MS, busy });
}

// Settles a job whose worker is gone, so status, result, check, list, cancel,
// and the next round never treat a dead worker as still running. Seats whose
// results the worker had saved keep them, and the job turns terminal in the
// same hold of the lock that decided it was dead, so a worker that was only
// slow to start cannot claim it afterwards. The caller holds the state lock.
async function reconcileLocked(root, job, { cancelled = false, note = "" } = {}) {
  const current = loadJob(root, job.id);
  if (!current) throw new Error(`Research job ${job.id} no longer exists; prune may have removed it.`);
  if (!workerGone(current)) return current;
  const wasCancelled = cancelled || cancelRequestedFor(root, current.id);
  const stopped = [];
  for (const seatId of current.seat_order) {
    const state = current.seats[seatId];
    if (!seatActive(state)) continue;
    if (killTreeOf(state.pid, state.pid_started)) stopped.push(state.pid);
    const saved = loadResult(root, current, seatId);
    if (saved) Object.assign(state, completedState(saved));
  }
  // What was stopped gets a moment to go, and what does not go is named.
  for (let attempt = 0; attempt < 40 && stopped.some((pid) => !groupGone(pid)); attempt += 1) await sleep(50);
  const lingering = stopped.find((pid) => !groupGone(pid));
  const reason = wasCancelled ? "Cancelled by user." : "The research worker exited before this researcher finished.";
  const lingeringNote = lingering && !note.includes("still running afterwards") ? lingeringGroupNote(lingering) : "";
  endSeats(current, wasCancelled ? "cancelled" : "failed", `${reason}${note}${lingeringNote}`);
  current.recovered = true;
  return concludeLocked(root, current, wasCancelled);
}

async function reconcileJob(root, job, options = {}) {
  if (!workerGone(job)) return job;
  return withStateLock(root, () => reconcileLocked(root, job, options));
}

// A worker that never claimed its job, because another round held the thread
// or the job had already left the queue, settles a job still queued so that
// it never blocks the thread.
function failUnclaimedJob(root, job, error) {
  return withStateLock(root, () => {
    const current = loadJob(root, job.id);
    if (current?.status !== "queued") return;
    endSeats(current, "failed", error.message);
    concludeLocked(root, current, false);
  });
}

// The request is also written down, after the researchers are told to stop,
// so that another command settling this job before the worker does, as
// `status` does for one that waited too long, records it as cancelled too.
function installCancellationHandlers(root, job) {
  const cancel = () => {
    requestCancel();
    // Thrown here, the error would end the worker before it settles the job;
    // the round is cancelled all the same, and only a command that settles it
    // first could miss why.
    try {
      requestCancelFile(root, job.id);
    } catch (error) {
      process.stderr.write(`Warning: the cancel request could not be written down (${error.code ?? error.message}).\n`);
    }
  };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  return () => {
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
  };
}

async function runRound(root, job) {
  const removeHandlers = installCancellationHandlers(root, job);
  try {
    return await executeRound(root, job);
  } catch (error) {
    await failUnclaimedJob(root, job, error);
    throw error;
  } finally {
    removeHandlers();
  }
}

async function startBackground(root, job) {
  // Spawned only while the job is still queued, so a cancel that landed after
  // preparation is never undone by the launch.
  const pending = await withStateLock(root, () => loadJob(root, job.id));
  if (pending?.status !== "queued") return pending ?? job;
  const logDescriptor = fs.openSync(logPath(root, job.id), "a");
  const child = spawn(process.execPath, [SCRIPT_PATH, "__run-round", job.id, "--dir", job.repo_root], {
    cwd: job.repo_root,
    detached: true,
    stdio: ["ignore", logDescriptor, logDescriptor],
    env: process.env
  });
  child.unref();
  fs.closeSync(logDescriptor);
  // Recorded only while the worker has not claimed the job, so a fast worker's
  // state is never overwritten with this older copy.
  return withStateLock(root, () => {
    const current = loadJob(root, job.id);
    if (!current) return job;
    if (current.status === "queued" && !current.pid) {
      current.pid = child.pid;
      current.pid_started = processStartTime(child.pid);
      saveJob(root, current);
    }
    return current;
  });
}

// The round's text: the question file, if any, then what the command line
// adds. The file is read once, here, so a background worker never needs it.
function questionText(parsed) {
  const file = parsed.options.questionFile ? readOptionFile("--question-file", parsed.options.questionFile) : null;
  if (file && !file.text.trim()) throw new Error(`--question-file ${file.path} is empty.`);
  if (!file) return { text: parsed.text, file: null };
  return { text: `The user's file ${file.path} says:\n\n${file.text.trimEnd()}${parsed.text ? `\n\nThe user added:\n\n${parsed.text}` : ""}`, file };
}

// The seats of a later round: the last round's, or the ones --with names,
// which may be seats the thread has or researchers to add to it.
function seatsForAgain(thread, options, mode) {
  const last = thread.rounds.at(-1);
  if (!options.with) return { seats: last.seats.map((id) => thread.seats.find((seat) => seat.id === id)), added: [] };
  const taken = new Set(thread.seats.map((seat) => seat.id));
  const chosen = [];
  const added = [];
  for (const name of options.with) {
    const existing = thread.seats.find((seat) => seat.id === name && !chosen.includes(seat));
    if (existing) {
      chosen.push(existing);
      continue;
    }
    validateResearcherNames([name.replace(/-\d+$/, "")]);
    if (!Object.hasOwn(BACKENDS, name)) throw new Error(`Thread ${thread.id} has no seat ${name}. Its seats are ${thread.seats.map((seat) => seat.id).join(", ")}.`);
    const seat = newSeat(name, options, taken);
    chosen.push(seat);
    added.push(seat);
  }
  // Built-in lenses only, and only when the round names none of its own:
  // explicit ones apply to the whole round below, as on a first round.
  assignLenses(added, { ...options, lenses: [], noLens: options.noLens || options.lenses.length > 0 }, mode, thread.seats.length);
  return { seats: chosen, added };
}

// --no-lens and --lens on a later round apply to its seats in order, those
// the thread already had included.
function overrideLenses(seats, options) {
  if (options.noLens) for (const seat of seats) seat.lens = null;
  if (options.lenses.length > seats.length) {
    throw new Error(`${options.lenses.length} lenses were given for ${seats.length} seat(s) in this round. Name more researchers with --with; a name may repeat.`);
  }
  options.lenses.forEach((lens, index) => {
    seats[index].lens = { name: `lens ${index + 1}`, text: lens };
  });
}

async function prepareRound(parsed, repoRoot, root, env = process.env) {
  const { options } = parsed;
  const { text, file } = questionText(parsed);
  return withStateLock(root, async () => {
    const notices = [];
    let thread;
    let seats;
    let mode;
    if (parsed.command === "again") {
      thread = loadThread(root, chooseJob(root, parsed.id).thread_id);
      // A round whose worker died is settled under the same hold of the lock
      // that admits the next one, so no death in between can be missed.
      let latest = loadJobs(root).find((job) => job.thread_id === thread.id);
      if (workerGone(latest)) {
        latest = await reconcileLocked(root, latest);
        thread = loadThread(root, thread.id);
      }
      if (jobActive(latest)) {
        throw new Error(`Round ${latest.round} of thread ${thread.id} is still ${latest.status} as job ${latest.id}. Wait for it with result ${latest.id} --wait, or cancel it.`);
      }
      mode = options.mode ?? thread.rounds.at(-1).mode;
      const selected = seatsForAgain(thread, options, mode);
      seats = selected.seats;
      thread.seats.push(...selected.added);
      overrideLenses(seats, options);
      for (const seat of seats.filter((entry) => !selected.added.includes(entry))) {
        const backend = BACKENDS[seat.backend];
        seat.effort = effortFor(options, backend, seat.effort);
        seat.capability = capabilityFor(options, backend, seat.capability);
        seat.model = options.models[seat.backend] ?? options.models.all ?? seat.model;
      }
      if (!text && !selected.added.length) throw new Error("Say what this round should do after --, such as a follow-up question or the user's decisions.");
    } else {
      if (!text) throw new Error(`Give the ${parsed.command === "brainstorm" ? "problem" : "question"} after --.`);
      if (options.mode && options.mode !== parsed.command) throw new Error(`--mode applies to again; ${parsed.command} always starts a ${parsed.command} thread.`);
      mode = parsed.command;
      const names = options.with ?? defaultPanel(env);
      validateResearcherNames(names);
      const taken = new Set();
      seats = names.map((name) => newSeat(name, options, taken));
      assignLenses(seats, options, mode, 0);
      thread = {
        version: STATE_VERSION,
        id: newId("T", new Set(fs.readdirSync(path.join(root, "threads")))),
        created_at: now(),
        repo_root: repoRoot,
        branch: git(repoRoot, ["branch", "--show-current"], { allowFailure: true }).stdout.trim() || null,
        mode,
        question: text,
        seats,
        rounds: [],
        ledger: {}
      };
    }
    validateOverrides(options, seats);
    refuseSeats(seats, env);

    const number = thread.rounds.length + 1;
    // Only from the text given on the command line, so that a file, which may
    // be committed or written by someone else, cannot record a decision.
    const decisions = parsed.command === "again" ? applyDecisions(thread, parsed.text, number) : { recorded: [], warnings: [] };
    if (parsed.command === "again" && DECISION_SHAPED.test(file?.text ?? "")) {
      decisions.warnings.push(`${file.path} contains text that looks like decisions, and none of it was recorded. Decisions are read only from the text after --.`);
    }
    const jobs = new Set(loadJobs(root).map((job) => job.id));
    const id = newId(`research-${Date.now().toString(36)}`, jobs);
    const round = {
      number,
      mode,
      text,
      // Later brainstorm rounds build on the pool; later research rounds stay
      // independent unless asked to check each other.
      shared: number > 1 && (options.share ?? mode === "brainstorm"),
      ideas: options.ideas ?? DEFAULT_IDEAS,
      seats: seats.map((seat) => seat.id),
      job_id: id,
      created_at: now(),
      decisions: decisions.recorded,
      settled_at: null
    };
    thread.rounds.push(round);
    const job = {
      version: STATE_VERSION,
      id,
      thread_id: thread.id,
      round: number,
      mode,
      status: "queued",
      created_at: now(),
      started_at: null,
      completed_at: null,
      repo_root: repoRoot,
      pid: null,
      pid_started: null,
      timeout_minutes: options.timeoutMinutes,
      seat_order: round.seats,
      // Each seat's settings as this round ran them, which a later round may change.
      seats: Object.fromEntries(seats.map((seat) => [seat.id, {
        status: "queued",
        backend: seat.backend,
        lens: seat.lens,
        model: seat.model,
        effort: seat.effort,
        capability: seat.capability,
        pid: null,
        pid_started: null,
        started_at: null,
        completed_at: null,
        error: null
      }])),
      warnings: decisions.warnings,
      notices,
      error: null
    };
    fs.mkdirSync(roundDirectory(root, thread.id, number), { recursive: true });
    // The job first: until the thread lists it, it is no round at all.
    saveJob(root, job);
    saveThread(root, thread);
    return job;
  });
}

async function waitForJob(root, job, minutes) {
  const deadline = Date.now() + minutes * 60 * 1000;
  let current = await reconcileJob(root, job);
  while (jobActive(current) && Date.now() < deadline) {
    await sleep(Math.min(WAIT_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    const latest = loadJob(root, job.id);
    if (!latest) throw new Error(`Research job ${job.id} no longer exists; prune may have removed it.`);
    current = await reconcileJob(root, latest);
  }
  return current;
}

function describeSettled(job) {
  const lingering = job.seat_order.map((seatId) => /A process that the researcher started was still running afterwards[^.]*\./.exec(job.seats[seatId].error ?? "")?.[0]).find(Boolean);
  const note = lingering ? ` ${lingering}` : "";
  if (job.status === "cancelled") return `Cancelled research job ${job.id}.${note}`;
  return `Job ${job.id} finished as ${job.status} before it could be cancelled.${note}`;
}

// The job reads as cancelled only after its worker has stopped every
// researcher and settled the thread, so a round started right after cancel
// returns cannot find the old one still holding the thread.
async function cancelJob(root, selected) {
  if (!jobActive(selected)) return `Job ${selected.id} is already ${selected.status}.`;
  const reconciled = await reconcileJob(root, selected);
  if (!jobActive(reconciled)) return `Job ${reconciled.id} had already stopped and is now ${reconciled.status}.`;
  const marked = await withStateLock(root, () => {
    const current = loadJob(root, selected.id);
    if (!current || !jobActive(current)) return current;
    // First, so that a cancel interrupted from here on still stops the job,
    // at its claim or by the worker that watches for it.
    requestCancelFile(root, current.id);
    if (!current.pid) {
      endSeats(current, "cancelled", "Cancelled by user.");
      concludeLocked(root, current, true);
    }
    return current;
  });
  if (!marked) return `Research job ${selected.id} no longer exists; prune may have removed it.`;
  if (!jobActive(marked)) return describeSettled(marked);
  if (!processVerified(marked.pid, marked.pid_started ?? null)) {
    const latest = await reconcileJob(root, loadJob(root, marked.id) ?? marked);
    if (!jobActive(latest)) return describeSettled(latest);
    return `Could not confirm that PID ${marked.pid} is still the worker of research job ${marked.id}, so nothing was signalled. If it is, stop it with kill ${marked.pid}; the next status then settles the job as cancelled.`;
  }
  signalProcess(marked.pid, marked.pid_started ?? null, "SIGTERM");
  const deadline = Date.now() + CANCEL_WAIT_MS;
  let current = marked;
  while (jobActive(current) && !workerGone(current) && Date.now() < deadline) {
    await sleep(200);
    current = loadJob(root, selected.id) ?? current;
  }
  if (!jobActive(current)) return describeSettled(current);
  // The worker did not finish its cleanup in time, so stop everything it
  // started, what those started included, and settle the job as a recovery
  // would. Its children are listed while it is alive to be asked.
  const orphans = current.pid_started ? descendantsOf(current.pid, current.pid_started) : [];
  const groups = current.seat_order.map((seatId) => current.seats[seatId])
    .filter((state) => seatActive(state) && state.pid && killTreeOf(state.pid, state.pid_started));
  signalProcess(current.pid, current.pid_started ?? null, "SIGKILL");
  killProcesses(orphans);
  for (let attempt = 0; attempt < 50 && !workerGone(current); attempt += 1) await sleep(50);
  for (let attempt = 0; attempt < 40 && groups.some((state) => !groupGone(state.pid)); attempt += 1) await sleep(50);
  const lingering = groups.find((state) => !groupGone(state.pid));
  return describeSettled(await reconcileJob(root, current, { cancelled: true, note: lingering ? lingeringGroupNote(lingering.pid) : "" }));
}

function elapsed(from, to) {
  const seconds = Math.max(0, Math.round((Date.parse(to ?? now()) - Date.parse(from)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function ago(from) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(from)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 60 / 24)}d`;
}

function clip(text, limit) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}\u2026` : flat;
}

function displayPath(job, file) {
  const relative = path.relative(job.repo_root, file);
  return relative.startsWith("..") ? file : relative;
}

function sourceLocation(source) {
  return source.url ?? source.file ?? "(no location)";
}

function seatSummary(job, seatId) {
  const state = job.seats[seatId];
  const noun = job.mode === "brainstorm" ? "idea" : "claim";
  if (state.status === "completed") {
    const counted = state.degraded ? "output that did not match the schema" : `${state.count} ${noun}${state.count === 1 ? "" : "s"}`;
    return `completed in ${elapsed(state.started_at, state.completed_at)}, ${counted}`;
  }
  if (state.status === "running") return `running for ${elapsed(state.started_at)}`;
  if (state.status === "queued") return "queued";
  return `${state.status}${state.error ? `: ${clip(state.error, 300)}` : ""}`;
}

function dispositionTag(ledger, id) {
  const disposition = ledger[id]?.disposition;
  return disposition && disposition !== "open" ? ` {${disposition}}` : "";
}

function renderResearch(structured, ledger) {
  const lines = [`Summary: ${structured.summary}`, "", `Claims (${structured.claims.length}):`];
  for (const claim of structured.claims) {
    lines.push(`${claim.id} [${claim.confidence}, ${claim.basis}]${dispositionTag(ledger, claim.id)} ${claim.statement}`);
    for (const source of claim.sources) lines.push(`  - ${sourceLocation(source)}`, `    "${source.quote}"`);
    if (!claim.sources.length) lines.push("  (no source cited)");
    if (claim.responds_to) lines.push(`  ${claim.stance === "independent" ? "About" : `${claim.stance[0].toUpperCase()}${claim.stance.slice(1)}`} ${claim.responds_to}${ledger[claim.responds_to] ? ` (${ledger[claim.responds_to].seat}): ${clip(ledger[claim.responds_to].text, 160)}` : ""}`);
    if (claim.note.trim()) lines.push(`  Note: ${claim.note.trim()}`);
  }
  if (structured.gaps.length) lines.push("", "Gaps:", ...structured.gaps.map((gap) => `- ${gap}`));
  if (structured.artifacts.length) lines.push("", "Artifacts:", ...structured.artifacts.map((artifact) => `- ${artifact.path}${artifact.description ? `: ${artifact.description}` : ""}`));
  return lines;
}

function renderBrainstorm(structured, ledger) {
  const lines = [`Framing: ${structured.framing}`, "", `Ideas (${structured.ideas.length}):`];
  for (const idea of structured.ideas) {
    lines.push(`${idea.id}${idea.from_lens ? " [lens]" : ""}${dispositionTag(ledger, idea.id)} ${idea.title}`);
    lines.push(`  What: ${idea.description}`);
    if (idea.wins_when.trim()) lines.push(`  Wins when: ${idea.wins_when.trim()}`);
    if (idea.assumption.trim()) lines.push(`  Assumes: ${idea.assumption.trim()}`);
    if (idea.test.trim()) lines.push(`  Test: ${idea.test.trim()}`);
    for (const source of idea.precedents) lines.push(`  Precedent: ${sourceLocation(source)}`, `    "${source.quote}"`);
    if (idea.builds_on.length) lines.push(`  Builds on: ${idea.builds_on.join(", ")}`);
  }
  if (structured.questions.length) lines.push("", "Questions:", ...structured.questions.map((question) => `- ${question}`));
  return lines;
}

function renderSeat(root, job, thread, seatId) {
  const state = job.seats[seatId];
  const seat = thread.seats.find((entry) => entry.id === seatId);
  const backend = BACKENDS[seat.backend];
  const lines = [
    `== ${seatId}: ${seatSummary(job, seatId)} ==`,
    `${backend.reviewerLabel}, effort ${state.effort}, ${state.capability}${state.cli_version ? `, ${backend.versionLabel} ${state.cli_version}` : ""}${state.model ? `, model ${state.model}` : ""}`
  ];
  if (state.lens) lines.push(`Lens: ${state.lens.name}`);
  if (state.warning) lines.push(`Warning: ${state.warning}`);
  if (state.status !== "completed") return lines;
  const result = loadResult(root, job, seatId);
  if (!result) return [...lines, "Error: this seat's result is missing, or is not one this runtime wrote."];
  if (result.conversation_id) lines.push(`${backend.conversationLabel}: ${result.conversation_id}${state.resumed ? " (resumed)" : ""}`);
  if (result.activity) lines.push(`Activity: ${result.activity}`);
  if (result.degraded) {
    const raw = String(result.raw ?? "").split(/\r?\n/);
    lines.push(
      `Warning: ${backend.reviewerLabel} did not return output matching the schema, so it is shown as returned, with no ids to decide on.${result.schema_errors.length ? ` ${result.schema_errors.slice(0, 5).join("; ")}.` : ""}`,
      "",
      ...raw.slice(0, MAX_RAW_LINES),
      ...(raw.length > MAX_RAW_LINES ? [`... ${raw.length - MAX_RAW_LINES} more lines in ${displayPath(job, seatFile(root, job, seatId, "json"))}`] : [])
    );
    return lines;
  }
  lines.push("", ...(result.mode === "brainstorm" ? renderBrainstorm(result.structured, thread.ledger) : renderResearch(result.structured, thread.ledger)));
  return lines;
}

// Sources are compared across seats by address, without the parts of one
// that differ between two links to the same page.
export function sourceKey(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return address;
  }
  url.hash = "";
  for (const name of [...url.searchParams.keys()]) if (/^utm_/i.test(name)) url.searchParams.delete(name);
  return `${url.hostname.replace(/^www\./, "").toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

function seatResults(root, job) {
  return job.seat_order
    .filter((seatId) => job.seats[seatId].status === "completed")
    .map((seatId) => ({ seatId, result: loadResult(root, job, seatId) }))
    .filter(({ result }) => result?.structured);
}

// Which researcher found what no one else did, which is what a second
// researcher is for.
function renderSourceOverlap(root, job) {
  const cited = new Map();
  const perSeat = new Map();
  for (const { seatId, result } of seatResults(root, job)) {
    perSeat.set(seatId, new Set());
    for (const claim of result.structured.claims) {
      for (const source of claim.sources) {
        if (!source.url) continue;
        const key = sourceKey(source.url);
        perSeat.get(seatId).add(key);
        if (!cited.has(key)) cited.set(key, { address: source.url, by: new Map() });
        const by = cited.get(key).by;
        by.set(seatId, [...(by.get(seatId) ?? []), claim.id]);
      }
    }
  }
  if (perSeat.size < 2 || !cited.size) return [];
  const site = (key) => key.split("/")[0];
  const lines = ["", "Web sources by seat:"];
  for (const [seatId, keys] of perSeat) {
    const alone = [...keys].filter((key) => cited.get(key).by.size === 1).length;
    lines.push(`- ${seatId}: ${keys.size} page${keys.size === 1 ? "" : "s"} on ${new Set([...keys].map(site)).size} site(s), ${alone} cited by no other seat`);
  }
  const both = [...cited.values()].filter((entry) => entry.by.size > 1);
  if (both.length) {
    lines.push("Cited by more than one seat, which is one source and not two:");
    for (const entry of both) lines.push(`- ${entry.address} (${[...entry.by].map(([seatId, ids]) => `${seatId} ${[...new Set(ids)].join(", ")}`).join("; ")})`);
  }
  return lines;
}

function renderPool(root, job, thread) {
  const ideas = Object.values(thread.ledger).filter((entry) => entry.kind === "idea");
  const here = ideas.filter((entry) => entry.round === job.round).length;
  const decided = ["pursued", "dropped", "parked"].map((disposition) => [disposition, ideas.filter((entry) => entry.disposition === disposition).length]).filter(([, count]) => count);
  return ["", `Pool: ${here} idea${here === 1 ? "" : "s"} from this round, ${ideas.length} in the thread${decided.length ? `; ${decided.map(([disposition, count]) => `${count} ${disposition}`).join(", ")}` : ""}.`];
}

function renderJob(root, job, full = false) {
  const thread = loadThread(root, job.thread_id);
  const round = thread.rounds.find((entry) => entry.number === job.round);
  const completed = job.seat_order.filter((seatId) => job.seats[seatId].status === "completed").length;
  const lines = [
    `Cross Research job: ${job.id}`,
    `Thread: ${thread.id} (round ${job.round}, ${job.mode})`,
    `Status: ${job.status}${jobActive(job) ? "" : `, ${completed} of ${job.seat_order.length} seat(s) completed`}`,
    `Repository: ${job.repo_root}`,
    `${thread.mode === "brainstorm" ? "Problem" : "Question"}: ${clip(thread.question, 400)}`
  ];
  if (job.round > 1 && round.text) lines.push(`This round: ${clip(round.text, 400)}`);
  if (round.shared) lines.push(`Shared: each seat saw ${job.mode === "brainstorm" ? "the pool of ideas so far" : "the other seats' last claims"}.`);
  if (round.decisions.length) {
    lines.push(`Decisions: ${round.decisions.map((decision) => `${decision.id} ${decision.disposition}${decision.note ? ` (${decision.note})` : ""}`).join("; ")}`);
  }
  for (const warning of job.warnings ?? []) lines.push(`Warning: ${warning}`);
  if (job.recovered) lines.push("Recovery: the worker for this round exited early; seats that had finished kept their results.");
  if (job.error) lines.push(`Error: ${job.error}`);
  if (!full) {
    lines.push("Seats:", ...job.seat_order.map((seatId) => `- ${seatId}: ${seatSummary(job, seatId)}`));
    return lines.join("\n");
  }
  for (const seatId of job.seat_order) lines.push("", ...renderSeat(root, job, thread, seatId));
  if (jobActive(job)) return lines.join("\n");
  lines.push(...(job.mode === "brainstorm" ? renderPool(root, job, thread) : renderSourceOverlap(root, job)));
  lines.push("", `Report: ${displayPath(job, reportPath(root, job))}`);
  if (completed) {
    lines.push(job.mode === "brainstorm"
      ? `Next: show the user every distinct idea with its id and who proposed it, then forward their choices, as in: again ${thread.id} -- "pursue I-..."`
      : `Next: run check ${job.id} to test every quote against its source before relaying anything.`);
  }
  return lines.join("\n");
}

async function checkRound(root, job, refresh) {
  const thread = loadThread(root, job.thread_id);
  const entries = [];
  for (const { seatId, result } of seatResults(root, job)) {
    const items = result.mode === "brainstorm" ? result.structured.ideas : result.structured.claims;
    for (const item of items) {
      const sources = result.mode === "brainstorm" ? item.precedents : item.sources;
      sources.forEach((source, index) => entries.push({ ...source, seat: seatId, item: item.id, index }));
    }
  }
  const checked = await checkSources(entries, { repoRoot: REPO_ROOT, cacheDirectory: sourcesDirectory(root, thread.id), refresh });
  let saveError = null;
  try {
    atomicWriteJson(checkPath(root, job), { version: STATE_VERSION, job_id: job.id, checked_at: now(), sources: checked });
  } catch (error) {
    // The quotes were checked, so they are shown all the same.
    saveError = error.code ?? error.message;
  }
  return { thread, checked, saveError };
}

function renderCheck(root, job, { thread, checked, saveError }) {
  const count = (list, status) => list.filter((entry) => entry.status === status).length;
  const tally = (list) => ["found", "partial", "missing", "unreachable", "unreadable"].map((status) => [status, count(list, status)]).filter(([, total]) => total).map(([status, total]) => `${total} ${status}`).join(", ") || "none";
  const lines = [
    `Source check for job ${job.id} (thread ${thread.id}, round ${job.round}): ${checked.length} quote${checked.length === 1 ? "" : "s"}; ${tally(checked)}.`,
    "found: the passage is in the source as quoted, as whole words. partial: most of it is, so read the source. missing: the source was read and does not contain it. unreachable or unreadable: the check could not read the source, which says nothing about the claim.",
    "A passage being in its source does not show that it supports the claim; read the claims that matter. Each web source names the file that holds the text it was checked against."
  ];
  const unkept = checked.filter((entry) => entry.cache_error);
  if (unkept.length) {
    lines.push(`Warning: the text of ${new Set(unkept.map((entry) => entry.url)).size} page(s) could not be kept as current (${unkept[0].cache_error}), so a later check either fetches them again or reads a copy kept before; pass --refresh to check against the page as it is.`);
  }
  if (saveError) lines.push(`Warning: this check's record could not be saved (${saveError}); what follows was not kept.`);
  for (const { seatId, result } of seatResults(root, job)) {
    const mine = checked.filter((entry) => entry.seat === seatId);
    lines.push("", `== ${seatId}: ${tally(mine)} ==`);
    const brainstorm = result.mode === "brainstorm";
    for (const item of brainstorm ? result.structured.ideas : result.structured.claims) {
      const sources = mine.filter((entry) => entry.item === item.id);
      if (brainstorm && !sources.length) continue;
      lines.push(`${item.id}${brainstorm ? "" : ` [${item.confidence}, ${item.basis}]`} ${clip(brainstorm ? item.title : item.statement, 240)}`);
      if (!sources.length) lines.push("  no source cited");
      for (const source of sources) {
        const detail = source.status === "found" ? "" : `: ${source.detail}`;
        const text = source.cache ? `; text: ${displayPath(job, source.cache)}` : "";
        lines.push(`  ${source.status.padEnd(11)} ${sourceLocation(source)}${detail}${text}`);
      }
    }
  }
  return lines.join("\n");
}

function renderList(root) {
  const threads = loadThreads(root);
  if (!threads.length) return "No research threads in this repository.";
  const jobs = loadJobs(root);
  return threads.map((thread) => {
    const latest = jobs.find((job) => job.thread_id === thread.id);
    const ideas = Object.values(thread.ledger).filter((entry) => entry.kind === "idea").length;
    const claims = Object.values(thread.ledger).length - ideas;
    return [
      `${thread.id} ${thread.mode}, ${thread.rounds.length} round(s), last ${latest?.status ?? "unknown"} ${ago(thread.updated_at)} ago`,
      `  Seats: ${thread.seats.map((seat) => seat.id).join(", ")}; ${claims} claim(s), ${ideas} idea(s)`,
      `  ${clip(thread.question, 200)}`
    ].join("\n");
  }).join("\n");
}

// Removes whole threads that have been idle for the given number of days,
// with their jobs, scratch directories, and kept sources.
// Whether a thread's scratch directory is there, looked up from the
// repository down: "absent" when a part of its path is missing or a file,
// "linked" when it is there behind a link, which prune removes nothing
// through, and "present" otherwise. A lookup that fails another way, as for
// want of permission, stops the prune with that error rather than reading as
// absence and orphaning the directory.
function scratchState(threadId) {
  let current = REPO_ROOT;
  for (const part of path.relative(REPO_ROOT, scratchRoot(threadId)).split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return "absent";
    if (stat.isSymbolicLink()) {
      // Followed only to learn whether anything is there, and only a missing
      // part or a file in the way means nothing is.
      try {
        fs.statSync(scratchRoot(threadId));
        return "linked";
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return "absent";
        throw error;
      }
    }
    if (!stat.isDirectory()) return "absent";
  }
  return "present";
}

async function pruneState(root, days) {
  if (!fs.existsSync(root)) return "No research threads in this repository.";
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const job of loadJobs(root)) await reconcileJob(root, job);
  return withStateLock(root, () => {
    const jobs = loadJobs(root);
    // Researchers write in the scratch directories, so one of them, or a
    // directory above, may have become a link, and prune removes nothing
    // through a link: each directory from the repository down is checked
    // just before the removal.
    // A round still running has researchers that can write in the checkout,
    // so while one runs, a thread with a scratch directory is left whole, its
    // records included, for a later prune to find again.
    const running = jobs.some(jobActive);
    let removed = 0;
    let linked = 0;
    let waiting = 0;
    for (const thread of loadThreads(root)) {
      const mine = jobs.filter((job) => job.thread_id === thread.id);
      if (Date.parse(thread.updated_at) > cutoff || mine.some(jobActive)) continue;
      const scratch = scratchState(thread.id);
      if (scratch !== "absent" && running) {
        waiting += 1;
        continue;
      }
      // The scratch directory goes first, so a removal that fails leaves the
      // records for the next prune to try again.
      if (scratch === "linked" || (scratch === "present" && !removeInside(REPO_ROOT, scratchRoot(thread.id)))) linked += 1;
      for (const job of mine) for (const suffix of ["json", "log", "cancel"]) fs.rmSync(path.join(root, "jobs", `${job.id}.${suffix}`), { force: true });
      removeInside(path.join(root, "threads"), threadDirectory(root, thread.id));
      removed += 1;
    }
    const notes = [`Removed ${removed} research thread(s) idle for more than ${days} day(s).`];
    if (linked) notes.push(`The scratch directories of ${linked} of them were left in place, because they lie behind a link.`);
    if (waiting) notes.push(`Left ${waiting} other idle thread(s) whole, because a round is still running and they have scratch directories; prune again once none runs.`);
    return notes.join(" ");
  });
}

export async function main(backends, scriptPath, argv = process.argv.slice(2)) {
  for (const backend of Object.values(backends)) validateBackend(backend);
  BACKENDS = backends;
  SCRIPT_PATH = scriptPath;
  if (argv[0] === "__run-round") {
    const directory = argv.indexOf("--dir");
    if (!argv[1] || directory < 0 || !argv[directory + 1]) throw new Error("Invalid internal job invocation.");
    REPO_ROOT = resolveRepository(argv[directory + 1]);
    const root = ensureStateRoot(REPO_ROOT);
    const finished = await runRound(root, chooseJob(root, argv[1]));
    process.stdout.write(`${renderJob(root, finished)}\n`);
    return;
  }

  const parsed = parseArguments(argv);
  const write = (text) => process.stdout.write(`${text}\n`);
  if (parsed.command === "help") return write(usage());
  const repoRoot = resolveRepository(parsed.options.dir);
  REPO_ROOT = repoRoot;
  // Only a round creates the state directory and the exclude entry, so a
  // control command in a repository never researched leaves nothing behind.
  const starting = START_COMMANDS.includes(parsed.command);
  if (starting) refuseHere(process.env);
  const root = starting ? ensureStateRoot(repoRoot) : stateRoot(repoRoot);

  if (parsed.command === "list") {
    // The newest job of each thread, settled first if its worker died.
    const seen = new Set();
    for (const job of loadJobs(root)) {
      if (!seen.has(job.thread_id)) await reconcileJob(root, job);
      seen.add(job.thread_id);
    }
    return write(renderList(root));
  }
  if (parsed.command === "prune") return write(await pruneState(root, parsed.options.olderThanDays ?? DEFAULT_PRUNE_DAYS));
  if (parsed.command === "status" || parsed.command === "result") {
    let job = await reconcileJob(root, chooseJob(root, parsed.id, parsed.options.round));
    if (parsed.options.wait) job = await waitForJob(root, job, parsed.options.waitMinutes);
    write(renderJob(root, job, parsed.command === "result"));
    if (parsed.options.wait && jobActive(job)) write(`Still ${job.status} after ${parsed.options.waitMinutes} minute(s); run ${parsed.command} ${job.id} --wait again to keep waiting.`);
    return;
  }
  if (parsed.command === "check") {
    const job = await reconcileJob(root, chooseJob(root, parsed.id, parsed.options.round));
    if (jobActive(job)) throw new Error(`Research job ${job.id} is still ${job.status}; check it once every seat has finished.`);
    return write(renderCheck(root, job, await checkRound(root, job, parsed.options.refresh)));
  }
  if (parsed.command === "cancel") return write(await cancelJob(root, chooseJob(root, parsed.id)));

  const job = await prepareRound(parsed, repoRoot, root);
  if (!parsed.options.wait) {
    const started = await startBackground(root, job);
    return write(`${renderJob(root, started)}\nCollect the reports with: result ${started.id} --wait`);
  }
  const finished = await runRound(root, job);
  write(renderJob(root, finished, true));
  if (finished.status !== "completed") process.exitCode = 1;
}
