// A server that floods stdout with one giant, unterminated frame. The adapter
// must cap inbound frame size rather than grow memory unbounded.
"use strict";
process.stdout.write("x".repeat(2_000_000));
setInterval(() => {}, 1_000_000);
