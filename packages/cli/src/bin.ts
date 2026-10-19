#!/usr/bin/env node
/**
 * Executable entry point.
 *
 * It exists only to wire the process's stdio into `runCli` and to translate the
 * returned code into `process.exitCode`. `runCli` already turns errors into
 * readable messages and exit codes; the try/catch here is the last line of
 * defence against a truly unexpected throw (e.g. a bad import), so the user
 * still sees a message rather than a raw stack.
 */

import { runCli } from "./index.ts";

try {
  const code = await runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    // Interactive prompts require a real terminal on stdin.
    isTTY: process.stdin.isTTY === true,
    stdin: process.stdin,
  });
  process.exitCode = code;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
