// A hostile/broken stdio server: prints a banner and non-JSON garbage to stdout,
// then never answers a JSON-RPC request. The adapter must treat this as a
// handshake/conformance failure, never as a trusted reply.
"use strict";
process.stdout.write("some banner that is not json\n");
process.stdout.write("another stray line\n");
setInterval(() => {
  // stay alive without ever speaking the protocol
}, 1_000_000);
