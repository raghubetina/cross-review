#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";

import claude from "./backends/claude.mjs";
import codex from "./backends/codex.mjs";
import { main } from "./runtime.mjs";

main({ codex, claude }, fileURLToPath(import.meta.url)).catch((error) => {
  process.stderr.write(`Cross Review error: ${error.message}\n`);
  process.exitCode = 1;
});
