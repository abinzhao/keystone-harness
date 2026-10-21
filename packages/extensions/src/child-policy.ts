/**
 * Defense in depth for read-only JS entries, not a security boundary against a
 * Node/V8 exploit. Node permissions deny writes/spawn/addons; these hooks deny
 * normal module/global network access on Node versions without net permissions.
 */
export function childReadOnlyPolicy(roots: readonly string[]): string {
  return [
    "import { registerHooks } from 'node:module';",
    "if (typeof registerHooks !== 'function') throw new Error('bounded module hooks unavailable');",
    `const allowedRoots = ${JSON.stringify(roots)};`,
    "const allowedBuiltins = new Set(['assert','assert/strict','buffer','events','fs','fs/promises','path','path/posix','path/win32','url','util','util/types','crypto','stream','stream/promises','stream/web','string_decoder','timers','timers/promises','readline','readline/promises','os','perf_hooks']);",
    "registerHooks({ resolve(specifier, context, nextResolve) {",
    " const resolved = nextResolve(specifier, context);",
    " if (resolved.url.startsWith('node:')) {",
    "  if (!allowedBuiltins.has(resolved.url.slice(5))) throw new Error('unsupported builtin');",
    " } else if (!allowedRoots.some(root => resolved.url.startsWith(root))) throw new Error('module outside reviewed snapshot');",
    " return resolved;",
    "} });",
    "for (const key of ['fetch','WebSocket','EventSource']) Object.defineProperty(globalThis,key,{value:undefined,writable:false,configurable:false});",
    "for (const key of ['getBuiltinModule','binding','_linkedBinding','dlopen','openStdin']) Object.defineProperty(process,key,{value:undefined,writable:false,configurable:false});",
  ].join("\n");
}
