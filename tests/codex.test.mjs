import fs from "node:fs";
import test from "node:test";

import { BACKENDS, defineSuite } from "./suite.mjs";

const B = BACKENDS.find((backend) => backend.name === "codex");
test.before(() => fs.chmodSync(B.fake, 0o755));
defineSuite(B);
