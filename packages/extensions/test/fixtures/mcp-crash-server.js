// A server that crashes immediately on start. The adapter must surface this as
// a handshake failure (and the bounded-restart path must not loop forever).
"use strict";
process.exit(7);
