import { createServer, request } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorizeApiRequest } from "../security/access.js";

const server = createServer((req, res) => {
  const decision = authorizeApiRequest({
    remoteAddress: req.socket.remoteAddress,
    authorization: req.headers.authorization,
    host: req.headers.host,
    origin: req.headers.origin,
    token: "",
  });
  res.statusCode = decision.status;
  res.end(decision.ok ? "private-owner-history" : "denied");
});
let port: number;
beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
function get(headers: Record<string, string | undefined>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path: "/api/runs", headers },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
describe("recipient websites cannot access the owner local workspace", () => {
  it("blocks rebound domains and deceptive local hostnames on a real loopback socket", async () => {
    for (const host of [
      "attacker.example",
      "127.evil.example",
      "localhost.evil.example",
      "localhost@evil.example",
    ]) {
      expect(await get({ Host: host })).toEqual({ status: 403, body: "denied" });
    }
  });
  it("blocks external and opaque browser origins despite a local Host", async () => {
    for (const origin of [
      "https://attacker.example",
      "null",
      "http://localhost.evil.example",
    ]) {
      expect(await get({ Host: `127.0.0.1:${port}`, Origin: origin })).toEqual({
        status: 403,
        body: "denied",
      });
    }
  });
  it("preserves local CLI and Vite frontend access", async () => {
    for (const headers of [
      { Host: `127.0.0.1:${port}` },
      { Host: `127.0.0.1:${port}`, Origin: "http://localhost:5190" },
    ]) {
      expect(await get(headers)).toEqual({
        status: 200,
        body: "private-owner-history",
      });
    }
  });
  it("fails closed without Host in token-free mode but retains explicit token access", () => {
    expect(
      authorizeApiRequest({
        remoteAddress: "127.0.0.1",
        authorization: undefined,
        token: "",
      }).ok,
    ).toBe(false);
    expect(
      authorizeApiRequest({
        remoteAddress: "127.0.0.1",
        host: "remote.example",
        authorization: "Bearer own-token",
        token: "own-token",
      }).ok,
    ).toBe(true);
  });
});
