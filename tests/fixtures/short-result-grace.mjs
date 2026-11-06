// Shortens the wait after a reviewer's result, which is 30 seconds in real use.
import agy from "../../plugins/cross-review/skills/cross-review/scripts/backends/agy.mjs";

agy.resultGraceMs = Number(process.env.SHORT_RESULT_GRACE_MS || 200);
