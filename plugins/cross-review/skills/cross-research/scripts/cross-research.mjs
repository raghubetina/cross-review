#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";

import agy from "../../cross-review/scripts/backends/agy.mjs";
import claude from "../../cross-review/scripts/backends/claude.mjs";
import codex from "../../cross-review/scripts/backends/codex.mjs";
import { main } from "./research.mjs";

main({ codex, claude, agy }, fileURLToPath(import.meta.url)).catch((error) => {
  process.stderr.write(`Cross Research error: ${error.message}\n`);
  process.exitCode = 1;
});
