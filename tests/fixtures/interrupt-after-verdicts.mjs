// Loaded with --import into a review process to interrupt the round right
// after its verdicts file lands, which no reviewer output can arrange.
// INTERRUPT_AFTER_VERDICTS=kill ends the process as a dying worker would;
// any other value makes the write throw as a failing disk would.

import fs from "node:fs";
import process from "node:process";

const renameSync = fs.renameSync;
fs.renameSync = (from, to) => {
  renameSync(from, to);
  if (!String(to).endsWith(".verdicts.json")) return;
  if (process.env.INTERRUPT_AFTER_VERDICTS === "kill") process.kill(process.pid, "SIGKILL");
  throw new Error(`Simulated failure after writing ${to}`);
};
