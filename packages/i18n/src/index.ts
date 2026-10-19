/**
 * `@keystone/i18n` — presentation-layer localisation.
 *
 * This package is the *only* place user-facing wording is produced in more than
 * one language. It is deliberately a leaf with no dependencies and no side
 * effects: protocol field names, event types and schema validation paths stay
 * English and never travel through here, because those are machine formats, not
 * prose. Only text a human reads does.
 *
 * The machine layer (kernel, tools, verifiers, models, schemas) is not
 * localised: the proof package in particular is a hash-addressed artifact that
 * must be byte-identical regardless of the language a run was displayed in.
 */

export {
  DEFAULT_LANGUAGE,
  LANGUAGE_ENV,
  LANGUAGES,
  isLanguage,
  normalizeLanguage,
  resolveLanguage,
  type Language,
  type LanguageSources,
} from "./language.ts";

export { catalogFor, translate, translatorFor, translatorForSources } from "./translate.ts";

export type { Catalog, TranslateParams, Translator } from "./types.ts";
