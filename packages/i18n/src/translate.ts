/**
 * Translation.
 *
 * Keys are the English source strings ("message ids", as in gettext): the code
 * stays in English, exactly like identifiers and comments, and a catalog maps a
 * source string to its translation. Two consequences follow, and both are why
 * this shape was chosen over invented ids:
 *
 *  - A missing translation degrades to the English source, which a user reads
 *    and reports; an invented id would degrade to a meaningless token.
 *  - English needs no catalog at all. `t("Run status")` is already the English
 *    text, so `en` is the identity translation and its catalog records only
 *    deliberate exceptions.
 *
 * Placeholders are `{name}` and are substituted from `params`. Substitution is
 * textual and happens after lookup, so a translated string carries the same
 * placeholders as its source.
 */

import { en } from "./catalog/en.ts";
import { zhCN } from "./catalog/zh-CN.ts";
import {
  DEFAULT_LANGUAGE,
  resolveLanguage,
  type Language,
  type LanguageSources,
} from "./language.ts";
import type { Catalog, TranslateParams, Translator } from "./types.ts";

const CATALOGS: Readonly<Record<Language, Catalog>> = {
  "zh-CN": zhCN,
  en,
};

function interpolate(template: string, params: TranslateParams | undefined): string {
  if (params === undefined) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Translate one key. Falls back to the key itself, which — keys being English —
 * is the correct English rendering, so an untranslated string is readable
 * rather than broken.
 */
export function translate(
  language: Language,
  key: string,
  params?: TranslateParams,
): string {
  const catalog = CATALOGS[language] ?? CATALOGS[DEFAULT_LANGUAGE];
  return interpolate(catalog[key] ?? key, params);
}

/**
 * The raw catalog for a language. Exposed for out-of-process surfaces (the
 * workbench ships the catalog to the browser and looks strings up client side),
 * so they do not have to duplicate the message table.
 */
export function catalogFor(language: Language): Catalog {
  return CATALOGS[language] ?? CATALOGS[DEFAULT_LANGUAGE];
}

/** Bind a language once, so call sites read `t("…")` rather than `translate(lang, "…")`. */
export function translatorFor(language: Language): Translator {
  return (key, params) => translate(language, key, params);
}

/** Resolve a language and bind it in one step, for callers that already hold the sources. */
export function translatorForSources(sources: LanguageSources): Translator {
  return translatorFor(resolveLanguage(sources));
}

export type { Catalog, TranslateParams, Translator } from "./types.ts";
