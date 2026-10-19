/**
 * Shared localisation types.
 *
 * Kept in their own module so that catalog files can be typed without importing
 * the translator (which imports the catalogs) and creating an import cycle.
 */

/** A language's message map: English source string -> translated string. */
export type Catalog = Readonly<Record<string, string>>;

/** Values substituted into `{name}` placeholders. */
export type TranslateParams = Readonly<Record<string, string | number>>;

/** A lookup bound to one language. */
export type Translator = (key: string, params?: TranslateParams) => string;
