import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ROOT, TARGETS, currentRelease, nextRecord, pluginDigest, pluginFiles, releaseProblems } from "../scripts/build.mjs";

// Codex keeps only this much of a skill it injects, whatever its docs say, so
// anything past it would silently never reach the model.
const CODEX_SKILL_PROMPT_BYTES = 8_000;
// Codex's and Antigravity's limit; Claude Code allows more.
const SKILL_DESCRIPTION_CHARACTERS = 1_024;

test("the plugin ships the files recorded for its manifest version", () => {
  const problems = releaseProblems(currentRelease());
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("a plugin digest covers every shipped file but not the manifest versions", () => {
  for (const target of TARGETS) {
    const files = pluginFiles(target);
    for (const file of [...target.manifests, `${target.skill}/scripts/runtime.mjs`, `${target.skill}/SKILL.md`]) {
      assert.ok(files.includes(file), `${file} is not among the digested files of ${target.plugin}`);
    }
  }

  const target = { directory: "plugins/p", manifests: ["plugins/p/.claude-plugin/plugin.json", "plugins/p/.codex-plugin/plugin.json"] };
  const skill = "plugins/p/skills/p/SKILL.md";
  const contents = { [target.manifests[0]]: '{"name":"p","version":"1.0.0"}', [target.manifests[1]]: '{"name":"p","version":"1.0.0"}', [skill]: "one\n" };
  const digest = (overrides) => {
    const files = { ...contents, ...overrides };
    return pluginDigest(target, Object.keys(files), (file) => Buffer.from(files[file]));
  };
  assert.equal(digest({ [target.manifests[0]]: '{\n  "name": "p",\n  "version": "1.0.1"\n}\n' }), digest({}));
  assert.equal(digest({ [target.manifests[1]]: '{\n  "name": "p",\n  "version": "1.0.1"\n}\n' }), digest({}));
  assert.notEqual(digest({ [skill]: "two\n" }), digest({}));
  assert.notEqual(digest({ [target.manifests[1]]: '{"name":"p","version":"1.0.0","description":"new"}' }), digest({}));
  assert.notEqual(digest({ "plugins/p/skills/p/references/interface.md": "added\n" }), digest({}));
});

test("every host's manifest describes the same plugin", () => {
  for (const target of TARGETS) {
    const manifests = target.manifests.map((file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")));
    for (const manifest of manifests) {
      assert.equal(manifest.name, target.plugin);
      for (const key of ["version", "description"]) assert.equal(manifest[key], manifests[0][key], key);
    }
  }
});

test("the skill fits what every host will load", () => {
  for (const target of TARGETS) {
    const skill = fs.readFileSync(path.join(ROOT, target.skill, "SKILL.md"));
    assert.ok(skill.length <= CODEX_SKILL_PROMPT_BYTES, `SKILL.md is ${skill.length} bytes; Codex truncates it at ${CODEX_SKILL_PROMPT_BYTES}.`);
    const [, description] = skill.toString("utf8").match(/^description: (.+)$/m);
    assert.ok(description.length <= SKILL_DESCRIPTION_CHARACTERS, `The description is ${description.length} characters.`);
    assert.ok(!description.includes(": "), "A colon and space ends a plain YAML value.");
  }
});

test("a change without a version bump is reported with the fix", () => {
  const versions = [{ where: "a/plugin.json", version: "1.2.3" }, { where: "b/marketplace.json", version: "1.2.3" }];
  const record = { "1.2.3": { "codex-review": "aa", "claude-review": "bb" } };
  assert.deepEqual(releaseProblems({ versions, digests: { "codex-review": "aa", "claude-review": "bb" }, record }), []);

  const [changed] = releaseProblems({ versions, digests: { "codex-review": "cc", "claude-review": "bb" }, record });
  assert.match(changed, /shipped files of codex-review differ from what scripts\/plugin-digests\.json records for version 1\.2\.3/);
  assert.match(changed, /Bump the version in a\/plugin\.json, b\/marketplace\.json, then run `npm run build`/);
  assert.match(changed, /If 1\.2\.3 is not on origin\/main yet, `npm run build` records the new digests under 1\.2\.3 instead\./);

  const bumped = versions.map((entry) => ({ ...entry, version: "1.2.4" }));
  assert.match(releaseProblems({ versions: bumped, digests: { "codex-review": "cc", "claude-review": "bb" }, record })[0], /Version 1\.2\.4 has no digests/);
  assert.match(
    releaseProblems({ versions: [versions[0], bumped[1]], digests: {}, record })[0],
    /disagree on the version \(a\/plugin\.json: 1\.2\.3, b\/marketplace\.json: 1\.2\.4\)/
  );
});

test("the build records a new version but never other digests for a version origin/main lists", () => {
  const versions = [{ where: "a/plugin.json", version: "1.2.4" }];
  const earlier = { "1.2.3": { "codex-review": "aa", "claude-review": "bb" } };
  const digests = { "codex-review": "cc", "claude-review": "dd" };

  const fresh = nextRecord({ versions, digests, record: earlier }, earlier);
  assert.deepEqual(fresh.record, { ...earlier, "1.2.4": digests });
  assert.equal(nextRecord({ versions, digests, record: fresh.record }, earlier).record, undefined);

  const record = { ...earlier, "1.2.4": { "codex-review": "cc", "claude-review": "ee" } };
  const unpushed = nextRecord({ versions, digests, record }, earlier);
  assert.deepEqual(unpushed.record, { ...earlier, "1.2.4": digests });
  assert.match(unpushed.recorded, /since origin\/main does not list 1\.2\.4/);
  assert.equal(nextRecord({ versions, digests, record }, {}).record["1.2.4"], digests);

  const pushed = nextRecord({ versions, digests, record }, record);
  assert.equal(pushed.record, undefined);
  assert.match(pushed.warning, /origin\/main lists other digests for 1\.2\.4 and installed copies may have it\. Bump the version/);

  // Another release pushed 1.2.4 after this branch's record was taken.
  const released = { ...earlier, "1.2.4": { "codex-review": "cc", "claude-review": "ee" } };
  const behind = nextRecord({ versions, digests, record: earlier }, released);
  assert.equal(behind.record, undefined);
  assert.match(behind.warning, /origin\/main lists other digests for 1\.2\.4/);
  assert.deepEqual(nextRecord({ versions, digests, record: earlier }, { ...earlier, "1.2.4": digests }).record, { ...earlier, "1.2.4": digests });
  const caughtUp = nextRecord({ versions, digests, record }, { ...earlier, "1.2.4": digests });
  assert.deepEqual(caughtUp.record, { ...earlier, "1.2.4": digests });
  assert.match(caughtUp.recorded, /Recorded the digests that origin\/main lists for 1\.2\.4/);

  const unknown = nextRecord({ versions, digests, record }, null);
  assert.equal(unknown.record, undefined);
  assert.match(unknown.warning, /origin\/main could not be read.*If 1\.2\.4 was never pushed, you may instead delete its entry/);
});
