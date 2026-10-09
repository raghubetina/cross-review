// Loaded with --import into a review process to make the session write that
// would apply a round fail once, after the round's numbered artifact has
// landed, which no reviewer output can arrange. Later session writes, such
// as retiring the session, succeed.

import fs from "node:fs";
import path from "node:path";

const renameSync = fs.renameSync;
let artifactWritten = false;
let failed = false;
fs.renameSync = (from, to) => {
  const name = path.basename(String(to));
  if (artifactWritten && !failed && name === "session.json") {
    failed = true;
    throw new Error(`Simulated failure writing ${to}`);
  }
  renameSync(from, to);
  if (/^\d{3}-.*\.md$/.test(name)) artifactWritten = true;
};
