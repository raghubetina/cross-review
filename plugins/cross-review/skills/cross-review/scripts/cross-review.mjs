#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";

import agy from "./backends/agy.mjs";
import claude from "./backends/claude.mjs";
import codex from "./backends/codex.mjs";
import { main } from "./runtime.mjs";

main({ codex, claude, agy }, fileURLToPath(import.meta.url)).catch((error) => {
  process.stderr.write(`Cross Review error: ${error.message}\n`);
  process.exitCode = 1;
});
