import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as ext from "../src/index.ts";

test("progressive Skill loading binds reviewed body/resources and excludes scripts and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-skill-boundary-"));
  try {
    await mkdir(join(root, "resources"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "SKILL.md"), "---\nname: fixture\ndescription: a fixture\n---\n\nBody");
    await writeFile(join(root, "resources/guide.md"), "reviewed guide");
    await writeFile(join(root, "scripts/run.sh"), "exit 1");
    const disclosure = await ext.inspectSkill(root);
    assert.ok(disclosure);
    await assert.rejects(ext.readSkillResource(disclosure, "scripts/run.sh"), /declared|resource/i);
    await writeFile(join(root, "resources/new.md"), "not reviewed");
    await assert.rejects(ext.readSkillResource(disclosure, "resources/new.md"), /declared/i);
    await writeFile(join(root, "resources/guide.md"), "changed guide");
    await assert.rejects(ext.readSkillResource(disclosure, "resources/guide.md"), /changed|digest/i);
    await writeFile(join(root, "SKILL.md"), "---\nname: fixture\ndescription: new\n---\n\nChanged");
    await assert.rejects(ext.loadSkillBody(disclosure), /changed|digest/i);
    await symlink(join(root, "scripts"), join(root, "resources/link"));
    await assert.rejects(ext.inspectSkill(root), /symlink/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Skill reads are bounded and context fragments retain untrusted provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "keystone-skill-context-"));
  try {
    await writeFile(join(root, "SKILL.md"), "---\nname: fixture\ndescription: a fixture\n---\n\nBody");
    const skill = await ext.inspectSkill(root);
    assert.ok(skill);
    assert.equal(typeof ext.loadSkillContext, "function");
    const fragment = await ext.loadSkillContext(skill, { kind: "body" });
    assert.equal(fragment.content, "Body");
    assert.equal(fragment.provenance.trustLevel, "untrusted");
    assert.equal(fragment.provenance.digest, skill.digest);
    assert.equal(fragment.provenance.source, "skill:fixture/SKILL.md");
    await writeFile(join(root, "SKILL.md"), "x".repeat(256 * 1024 + 1));
    await assert.rejects(ext.inspectSkill(root), /limit|bound/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
