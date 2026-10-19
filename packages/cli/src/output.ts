/**
 * Terminal rendering.
 *
 * Two rules from the PRD shape this file:
 *
 *  - Human output is short, aligned and scannable — status, conditions and
 *    evidence are one line each (PRD 12.3).
 *  - Technical detail (hashes, ids, raw payloads) is folded away by default and
 *    only shown under `--verbose`. `detail()` is the single gate for that, so a
 *    command cannot accidentally leak an id into the default view.
 *
 * The output object never touches credentials: nothing here interpolates a
 * secret, and `error()` is the only path that writes to stderr.
 */

export interface WriteStream {
  write(chunk: string): unknown;
}

export interface OutputOptions {
  readonly stdout: WriteStream;
  readonly stderr: WriteStream;
  readonly json: boolean;
  /** When true, `detail()` writes; otherwise it is dropped. */
  readonly verbose?: boolean;
}

export type KeyValueInput = Record<string, string | number | boolean | undefined | null>;

export interface Output {
  /** A plain line to stdout. Suppressed in JSON mode so stdout stays valid JSON. */
  line(text: string): void;
  /** A titled block, separated by a blank line. */
  section(title: string): void;
  /** Aligned `key : value` rows; undefined/null values are skipped. */
  keyValue(record: KeyValueInput): void;
  /** Indented technical detail; only printed when `--verbose` is set. */
  detail(text: string): void;
  /** The structured result. Written to stdout unconditionally. */
  json(value: unknown): void;
  /** A message to stderr. Always written, regardless of mode. */
  error(text: string): void;
}

/**
 * True for characters a monospace terminal renders two columns wide. Covers the
 * CJK, Hangul, Hiragana/Katakana and fullwidth-form ranges — enough that a
 * Chinese label and an English label line up in the same column.
 */
const WIDE_CHARACTER =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** Display width in terminal columns, not code units. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) width += WIDE_CHARACTER.test(character) ? 2 : 1;
  return width;
}

export function createOutput(options: OutputOptions): Output {
  const human = options.json !== true;
  const verbose = options.verbose === true;

  const writeHuman = (text: string): void => {
    if (human) options.stdout.write(text);
  };

  return {
    line(text: string): void {
      writeHuman(`${text}\n`);
    },
    section(title: string): void {
      writeHuman(`\n${title}\n`);
    },
    keyValue(record: KeyValueInput): void {
      if (!human) return;
      const entries = Object.entries(record).filter(
        (entry): entry is [string, string | number | boolean] =>
          entry[1] !== undefined && entry[1] !== null,
      );
      if (entries.length === 0) return;
      // Pad by display width, so a localised (double-width) label aligns with an
      // English one instead of drifting.
      const width = entries.reduce((max, [key]) => Math.max(max, displayWidth(key)), 0);
      for (const [key, value] of entries) {
        const padding = " ".repeat(Math.max(0, width - displayWidth(key)));
        options.stdout.write(`${key}${padding} : ${String(value)}\n`);
      }
    },
    detail(text: string): void {
      if (!human || !verbose) return;
      options.stdout.write(`  ${text}\n`);
    },
    json(value: unknown): void {
      // Only in JSON mode: a human run should not get a JSON blob appended.
      if (options.json !== true) return;
      options.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    },
    error(text: string): void {
      options.stderr.write(`${text}\n`);
    },
  };
}
