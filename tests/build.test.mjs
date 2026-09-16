import assert from "node:assert/strict";
import test from "node:test";

import { staleCopies } from "../scripts/build.mjs";

test("each plugin ships an up-to-date copy of the shared runtime", () => {
  const stale = staleCopies();
  assert.deepEqual(stale, [], `Run \`npm run build\`; stale copies: ${stale.map((copy) => copy.to).join(", ")}`);
});
