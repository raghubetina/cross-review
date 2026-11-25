// Loaded with --import into a background review worker to change a reviewed
// file after the review was prepared and before its context is collected, as
// an editor saving at that moment would. The worker's first reviewer version
// check comes just before collection.

import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import process from "node:process";

const spawnSync = childProcess.spawnSync;
let edited = false;
childProcess.spawnSync = (binary, args, options) => {
  if (!edited && process.argv.includes("__run-job") && Array.isArray(args) && args.includes("--version")) {
    edited = true;
    fs.appendFileSync(process.env.EDIT_BEFORE_COLLECT, "edited after preparation\n");
  }
  return spawnSync(binary, args, options);
};
syncBuiltinESMExports();
