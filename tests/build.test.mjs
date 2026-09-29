import assert from "node:assert/strict";
import test from "node:test";

import { TARGETS, currentRelease, nextRecord, pluginDigest, pluginFiles, releaseProblems, staleCopies } from "../scripts/build.mjs";

test("each plugin ships an up-to-date copy of the shared runtime", () => {
  const stale = staleCopies();
  assert.deepEqual(stale, [], `Run \`npm run build\`; stale copies: ${stale.map((copy) => copy.to).join(", ")}`);
});

test("each plugin ships the files recorded for its manifest version", () => {
  const problems = releaseProblems(currentRelease());
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("a plugin digest covers every shipped file but not the manifest version", () => {
  for (const target of TARGETS) {
    const files = pluginFiles(target);
    for (const file of [target.manifest, `${target.scripts}/runtime.mjs`, `${target.directory}/skills/${target.plugin}/SKILL.md`]) {
      assert.ok(files.includes(file), `${file} is not among the digested files of ${target.plugin}`);
    }
  }

  const target = { directory: "plugins/p", manifest: "plugins/p/.claude-plugin/plugin.json" };
  const skill = "plugins/p/skills/p/SKILL.md";
  const contents = { [target.manifest]: '{"name":"p","version":"1.0.0"}', [skill]: "one\n" };
  const digest = (overrides) => {
    const files = { ...contents, ...overrides };
    return pluginDigest(target, Object.keys(files), (file) => Buffer.from(files[file]));
  };
  assert.equal(digest({ [target.manifest]: '{\n  "name": "p",\n  "version": "1.0.1"\n}\n' }), digest({}));
  assert.notEqual(digest({ [skill]: "two\n" }), digest({}));
  assert.notEqual(digest({ [target.manifest]: '{"name":"p","version":"1.0.0","description":"new"}' }), digest({}));
  assert.notEqual(digest({ "plugins/p/skills/p/references/interface.md": "added\n" }), digest({}));
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
