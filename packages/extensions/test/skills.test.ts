/**
 * Local Agent Skills loader tests (ADR-0009).
 *
 * Prove discovery is cheap and grants nothing: frontmatter-only listing,
 * on-demand body/resource loading, directory confinement, digest-based upgrade
 * detection, and the conformance checks.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  checkSkillConformance,
  discoverSkills,
  loadSkillBody,
  parseSkillMarkdown,
  readSkillResource,
  SkillAccessError,
} from "../src/index.ts";

async function makeSkillRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "keystone-skills-"));
  const skill = join(root, "git-commit");
  await mkdir(join(skill, "resources"), { recursive: true });
  await mkdir(join(skill, "scripts"), { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    [
      "---",
      "name: git-commit",
      'description: "how to write a scoped commit"',
      "metadata:",
      "  side_effects: read_only",
      "---",
      "",
      "Body prose the model reads on demand.",
      "",
    ].join("\n"),
  );
  await writeFile(join(skill, "resources", "template.md"), "commit template");
  await writeFile(join(skill, "scripts", "check.sh"), "#!/bin/sh\necho hi\n");
  return root;
}

test("frontmatter parses name/description/metadata and separates the body", () => {
  const result = parseSkillMarkdown("---\nname: demo\ndescription: a thing\nmetadata:\n  x: 1\n---\n\nbody here\n");
  assert.equal(result.ok, true);
  assert.equal(result.frontmatter?.name, "demo");
  assert.equal(result.frontmatter?.description, "a thing");
  assert.equal(result.frontmatter?.metadata["x"], "1");
  assert.equal(result.frontmatter?.body, "body here");
});

test("discovery lists frontmatter without running anything, and discloses resources/scripts", async () => {
  const root = await makeSkillRoot();
  const skills = await discoverSkills([root]);
  assert.equal(skills.length, 1);
  const [skill] = skills;
  assert.equal(skill?.name, "git-commit");
  assert.ok(skill?.resources.includes("resources/template.md"));
  assert.ok(skill?.scripts.includes("scripts/check.sh"));
  // No capability is granted by discovery: the disclosure carries no lease.
  assert.deepEqual(checkSkillConformance(skill!).filter((c) => !c.passed), []);
});

test("body and resources load on demand; escaping the skill dir is refused", async () => {
  const root = await makeSkillRoot();
  const [skill] = await discoverSkills([root]);
  assert.ok(skill !== undefined);
  const body = await loadSkillBody(skill);
  assert.ok(body.includes("Body prose"));
  const resource = await readSkillResource(skill, "resources/template.md");
  assert.equal(resource, "commit template");
  await assert.rejects(() => readSkillResource(skill, "../outside.txt"), SkillAccessError);
});

test("a changed SKILL.md surfaces as a new digest (upgrade detection)", async () => {
  const root = await makeSkillRoot();
  const [before] = await discoverSkills([root]);
  assert.ok(before !== undefined);
  await writeFile(join(before.dir, "SKILL.md"), "---\nname: git-commit\ndescription: updated\n---\n\nnew body\n");
  const [after] = await discoverSkills([root]);
  assert.ok(after !== undefined);
  assert.notEqual(before.digest, after.digest);
  assert.equal(after.description, "updated");
});

test("a skill that tries to declare a capability fails conformance", async () => {
  const root = await makeSkillRoot();
  const [skill] = await discoverSkills([root]);
  assert.ok(skill !== undefined);
  const withSelfGrant = { ...skill, metadata: { capabilities: "fs.write" } };
  const checks = checkSkillConformance(withSelfGrant);
  const selfGrant = checks.find((c) => c.checkId === "skill.no_self_grant");
  assert.equal(selfGrant?.passed, false);
});

test("a missing root is skipped rather than throwing", async () => {
  const skills = await discoverSkills([resolve(tmpdir(), "does-not-exist-keystone-xyz")]);
  assert.deepEqual(skills, []);
});
