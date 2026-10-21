import { createInterface } from "node:readline";
let calls = 0;
const mode = process.argv[2];
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  if (request.method === "initialize") {
    if (mode === "frame") process.stdout.write("x".repeat(8192) + "\n");
    else reply({ protocolVersion: mode === "version" ? "2099-01-01" : "2024-11-05",
      serverInfo: { name: "fixture", version: "1.0.0" } });
  } else if (request.method === "tools/call" && mode !== "hang") {
    calls++;
    if (calls === 1) process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: request.id, error: { code: -1, message: "rejected call" },
    }) + "\n");
    else reply({ content: [{ type: "text", text: String(calls) }] });
  }
});
