// File, lock, and process helpers for the research runtime. The review runtime
// in ../../cross-review/scripts/runtime.mjs keeps its own copies and does not
// export them, so a fix to one belongs in both.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const LOCK_STALE_MS = 12 * 60 * 60 * 1000;
const LOCK_POLL_MS = 50;
const LOCK_EMPTY_GRACE_MS = 10_000;
const LOCK_GUARD_STALE_MS = 10_000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${binary} ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
  return result;
}

export function git(cwd, args, options = {}) {
  return run("git", ["-C", cwd, "-c", "color.ui=false", ...args], options);
}

export function atomicWriteText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, value, "utf8");
  fs.renameSync(temporary, filePath);
}

export function atomicWriteJson(filePath, value) {
  atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Creates `to` with the finished contents of `from`, or returns false if `to`
// exists. A filesystem without hard links gets an exclusive create instead,
// which leaves a moment in which the lock is empty.
function createLockFile(from, to) {
  try {
    fs.linkSync(from, to);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(error.code)) throw error;
  }
  let descriptor;
  try {
    descriptor = fs.openSync(to, "wx");
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  fs.writeFileSync(descriptor, fs.readFileSync(from));
  fs.closeSync(descriptor);
  return true;
}

// Removes the lock only if it still holds the token read, while holding a
// guard, so of two contenders reclaiming at once neither can remove a lock
// that the other has just taken.
function removeLockIfUnchanged(lockPath, token) {
  const guard = `${lockPath}.reclaim`;
  const draft = `${guard}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(draft, `${process.pid}\n`, "utf8");
  try {
    if (!createLockFile(draft, guard)) {
      // A reclaimer that died holding the guard leaves it behind.
      const guardAge = Date.now() - (fs.statSync(guard, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (guardAge > LOCK_GUARD_STALE_MS && !processAlive(Number.parseInt(readText(guard) ?? "", 10))) fs.rmSync(guard, { force: true });
      return false;
    }
    try {
      if (readText(lockPath) === token) fs.rmSync(lockPath, { force: true });
    } finally {
      fs.rmSync(guard, { force: true });
    }
    return true;
  } finally {
    fs.rmSync(draft, { force: true });
  }
}

// Removes a lock whose owner is gone and returns whether to try again at
// once. An empty lock is one that the exclusive-create fallback is still
// writing, so it counts as live for a moment.
function reclaimStaleLock(lockPath) {
  const token = readText(lockPath);
  if (token === null) return true;
  const age = Date.now() - (fs.statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs ?? 0);
  if (!token.trim()) return age > LOCK_EMPTY_GRACE_MS && removeLockIfUnchanged(lockPath, token);
  if (processAlive(Number.parseInt(token, 10)) && age <= LOCK_STALE_MS) return false;
  return removeLockIfUnchanged(lockPath, token);
}

// A lock file holds its owner's PID and a random token, written whole before
// the file appears, so a contender never mistakes a new lock for an abandoned
// one, and only the owner of this token releases it.
export async function withLock(lockPath, callback, { waitMs = 0, busy = `Another process holds ${lockPath}.` } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid} ${crypto.randomBytes(6).toString("hex")}\n`;
  const draft = `${lockPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(draft, token, "utf8");
  const deadline = Date.now() + waitMs;
  try {
    while (!createLockFile(draft, lockPath)) {
      if (reclaimStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(busy);
      await sleep(LOCK_POLL_MS);
    }
  } finally {
    fs.rmSync(draft, { force: true });
  }
  try {
    return await callback();
  } finally {
    if (readText(lockPath) === token) fs.rmSync(lockPath, { force: true });
  }
}

export function processInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = spawnSync("ps", ["-o", "stat=", "-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const match = result.status === 0 ? result.stdout.trim().match(/^(\S+)\s+(.+)$/) : null;
  return match ? { state: match[1], started: match[2].trim() } : null;
}

export function processStartTime(pid) {
  return processInfo(pid)?.started ?? null;
}

// Whether the PID may still be the process recorded with this start time. A
// process ps cannot describe is assumed alive, so a job is never settled as
// dead on missing information.
export function processAlive(pid, started = null) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== "EPERM") return false;
  }
  const info = processInfo(pid);
  if (info?.state.startsWith("Z")) return false;
  if (!started) return true;
  return info === null || info.started === started;
}

// Whether the PID is known to be the process recorded with this start time,
// which is what a signal needs.
export function processVerified(pid, started) {
  if (!started || !processAlive(pid, started)) return false;
  return processInfo(pid)?.started === started;
}

export function signalProcess(pid, started, signal) {
  if (!processVerified(pid, started)) return false;
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  return true;
}

// A researcher runs as the leader of its own process group, so signalling the
// group also reaches the clones, downloads, and servers it started.
export function signalGroup(pid, signal) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if (error.code === "EPERM") return false;
    if (error.code !== "ESRCH") throw error;
  }
  return true;
}

export function groupGone(pid) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

// Escalates from SIGTERM to SIGKILL until no process is left in the group,
// and resolves to whether the group is gone. It never rejects.
export async function stopGroup(pid) {
  signalGroup(pid, "SIGTERM");
  for (let attempt = 0; attempt < 100 && !groupGone(pid); attempt += 1) await sleep(50);
  if (groupGone(pid)) return true;
  signalGroup(pid, "SIGKILL");
  for (let attempt = 0; attempt < 40 && !groupGone(pid); attempt += 1) await sleep(50);
  return groupGone(pid);
}

// Every process below this one, which can be asked only while it is alive. A
// CLI may start a command in a session of its own, and signalling the CLI's
// process group does not reach that command.
export function descendantsOf(pid, started = null) {
  // Each process's parent and start time come from one row, so the start time
  // is that of the process whose parentage was read, and a later signal can
  // tell it from another process that has since been given the same PID.
  const listed = spawnSync("ps", ["-A", "-o", "pid=,ppid=,lstart="], { encoding: "utf8" });
  if (listed.status !== 0) return [];
  const children = new Map();
  const startedAt = new Map();
  for (const line of listed.stdout.split("\n")) {
    const row = line.match(/^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/);
    if (!row) continue;
    const parent = Number(row[2]);
    startedAt.set(Number(row[1]), row[3]);
    children.set(parent, [...(children.get(parent) ?? []), { pid: Number(row[1]), started: row[3] }]);
  }
  // Given a start time, the process asked about must be that one in this same
  // listing, so the children of whatever took over its PID are never listed.
  if (started && startedAt.get(pid) !== started) return [];
  const found = [];
  for (const queue = [pid]; queue.length; ) {
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

// Two lists of processes as one, each process once.
export function mergeProcesses(first = [], second = []) {
  const merged = new Map();
  for (const entry of [...first, ...second]) merged.set(`${entry.pid} ${entry.started}`, entry);
  return [...merged.values()];
}

// Each of these processes that is still the one listed, and the group of any
// that leads one.
export function killProcesses(processes) {
  for (const { pid, started } of processes) {
    if (!started || processInfo(pid)?.started !== started) continue;
    signalGroup(pid, "SIGKILL");
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!["ESRCH", "EPERM"].includes(error.code)) throw error;
    }
  }
}

// Stops a researcher that nothing supervises any more: its process group,
// and, while its CLI is still there to ask, everything below the CLI. A group
// can outlive its leader, and its ID cannot go to a new process while any
// member lives, so the group is stopped unless its leader's PID now belongs
// to another process. Returns whether it signalled the group.
export function killTreeOf(pid, started) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const info = processInfo(pid);
  if (info && info.started !== started) return false;
  if (!info && processAlive(pid)) return false;
  const below = info ? descendantsOf(pid, started) : [];
  signalGroup(pid, "SIGKILL");
  killProcesses(below);
  return true;
}

// Removes `target` only if it lies inside `root` through real directories, so
// a link that something put in its path cannot point the removal elsewhere.
// Returns whether it removed anything.
export function removeInside(root, target) {
  if (!fs.existsSync(root)) return false;
  const base = fs.realpathSync(root);
  let current = target;
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) return false;
    current = path.dirname(current);
  }
  if (current !== root || !fs.existsSync(target)) return false;
  if (!fs.realpathSync(target).startsWith(`${base}${path.sep}`)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}
