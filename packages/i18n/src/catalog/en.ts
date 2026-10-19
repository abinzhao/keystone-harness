/**
 * English catalog.
 *
 * Empty on purpose: message ids are the English source strings, so English is
 * the identity translation and `translate("en", "Run status")` already yields
 * "Run status" without an entry here. Add a key only to deliberately override
 * a source string for the English rendering (e.g. to expand an abbreviation).
 */

import type { Catalog } from "../types.ts";

export const en: Catalog = {};
