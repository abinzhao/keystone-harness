// A minimal, compliant stdio MCP server for tests. No imports, so it runs
// under both CJS and ESM package layouts. Speaks initialize / tools/list /
// tools/call over newline-delimited JSON.
"use strict";

let buffer = "";
function send(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`);
}
function handle(line) {
  if (line.trim() === "") return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return; // stray line, ignored
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "echo-server", version: "1.2.3" },
      },
    });
  } else if (message.method === "notifications/initialized") {
    // nothing to reply to
  } else if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          { name: "echo", description: "echoes its input back", inputSchema: { type: "object" } },
          { name: "shout", description: "upper-cases input", inputSchema: { type: "object" } },
        ],
      },
    });
  } else if (message.method === "tools/call") {
    const args = (message.params && message.params.arguments) || {};
    const name = message.params && message.params.name;
    const text = name === "shout" ? JSON.stringify(args).toUpperCase() : `echo:${JSON.stringify(args)}`;
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }], isError: false } });
  }
}
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    handle(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
  }
});
