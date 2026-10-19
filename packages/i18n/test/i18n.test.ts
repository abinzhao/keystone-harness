/**
 * Language resolution and translation.
 *
 * These tests pin down the two rules the rest of the product depends on: the
 * default is Chinese, and the precedence is flag > env > config > default.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LANGUAGE,
  LANGUAGE_ENV,
  normalizeLanguage,
  resolveLanguage,
  translate,
  translatorFor,
} from "../src/index.ts";

test("the shipped default language is Chinese", () => {
  assert.equal(DEFAULT_LANGUAGE, "zh-CN");
  assert.equal(resolveLanguage({}), "zh-CN");
});

test("language precedence is flag, then env, then config", () => {
  assert.equal(resolveLanguage({ flag: "en", env: "zh-CN", config: "zh-CN" }), "en");
  assert.equal(resolveLanguage({ env: "en", config: "zh-CN" }), "en");
  assert.equal(resolveLanguage({ config: "en" }), "en");
});

test("a bad value at one level falls through to the next", () => {
  assert.equal(resolveLanguage({ flag: "fr", env: "en" }), "en");
  assert.equal(resolveLanguage({ flag: "", env: "klingon", config: "zh-CN" }), "zh-CN");
});

test("language tags are normalised across common spellings", () => {
  for (const value of ["zh", "zh-CN", "zh-cn", "zh-Hans", "zh-Hans-CN"]) {
    assert.equal(normalizeLanguage(value), "zh-CN", value);
  }
  for (const value of ["en", "EN", "en-US", "en-GB"]) {
    assert.equal(normalizeLanguage(value), "en", value);
  }
  assert.equal(normalizeLanguage("de"), undefined);
  assert.equal(normalizeLanguage(undefined), undefined);
});

test("the KEYSTONE_LANG constant names the env variable", () => {
  assert.equal(LANGUAGE_ENV, "KEYSTONE_LANG");
});

test("Chinese is used for known keys and interpolation substitutes placeholders", () => {
  const t = translatorFor("zh-CN");
  assert.equal(t("Commands:"), "命令：");
  assert.equal(t('unknown command "{command}"', { command: "nope" }), '未知命令 "nope"');
});

test("an unknown key falls back to the English source string", () => {
  assert.equal(translate("zh-CN", "Never translated"), "Never translated");
  assert.equal(translate("en", "Never translated"), "Never translated");
});

test("English is the identity translation, so its catalog stays empty", () => {
  assert.equal(translatorFor("en")("Commands:"), "Commands:");
});

test("a placeholder with no supplied value is left untouched", () => {
  assert.equal(translate("zh-CN", 'unknown command "{command}"'), '未知命令 "{command}"');
});
