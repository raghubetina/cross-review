#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";

import backend from "./backends/claude.mjs";
import { main } from "./runtime.mjs";

main(backend, fileURLToPath(import.meta.url)).catch((error) => {
  process.stderr.write(`${backend.reviewerLabel} Review error: ${error.message}\n`);
  process.exitCode = 1;
});
