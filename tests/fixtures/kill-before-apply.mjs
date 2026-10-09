// Loaded with --import into a review process to kill it as a dying worker
// would: right after the round's numbered artifact lands, before the session
// records the round.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const renameSync = fs.renameSync;
fs.renameSync = (from, to) => {
  renameSync(from, to);
  if (/^\d{3,}-.*\.md$/.test(path.basename(String(to)))) process.kill(process.pid, "SIGKILL");
};
