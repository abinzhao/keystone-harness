import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { loadConfigSnapshot } from "../../../models/src/index.ts";
import { join } from "node:path";

const home = process.env.KEYSTONE_HOME;
const server = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/v1/settings" && req.method === "GET") {
    const { config } = home ? await loadConfigSnapshot({ configFile: join(home, "config.json") })
      : { config: { models: [] } };
    const presentation = { language: "en" };
    res.end(JSON.stringify({
      revision: createHash("sha256").update(JSON.stringify({ config, presentation })).digest("hex"),
      config, presentation, pid: process.pid, home,
    }));
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  res.end(JSON.stringify({ pid: process.pid, home,
    sawAuthorization: req.headers.authorization, received: body ? JSON.parse(body) : null }));
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port, token: "fixture-token" }));
});
