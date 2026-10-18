import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  runtime = path.join(root, ".runtime"),
  secret = JSON.parse(
    fs.readFileSync(path.join(runtime, "secrets.json"), "utf8"),
  ),
  key = crypto.randomBytes(32).toString("hex"),
  ports = { A: 8481, B: 8482 },
  apps = {},
  children = {},
  network = { db: false, redis: false, pg: false, webhook: false },
  sockets = { db: new Set(), redis: new Set(), pg: new Set() },
  drops = new Map();
let testProcess = null;
let probeProcess = null;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const settings = spawnSync(
    process.env.JAVA_BIN || "java",
    ["-XshowSettings:properties", "-version"],
    { encoding: "utf8", windowsHide: true },
  ),
  javaHome = (settings.stderr || "")
    .match(/java\.home\s*=\s*([^\r\n]+)/)?.[1]
    ?.trim(),
  javaBin =
    process.env.JAVA_BIN ||
    (javaHome ? path.join(javaHome, "bin/java.exe") : "java");
for (const port of [8480, 8481, 8482, 8483, 18480, 18481, 18482, 55453, 56490])
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", () => reject(Error("Port " + port + " already in use")));
    s.listen(port, "127.0.0.1", () => s.close(resolve));
  });
function child(name, file, args, env = {}) {
  const log = fs.openSync(path.join(runtime, name + ".log"), "a"),
    p = spawn(file, args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, ...env },
    });
  children[name] = p;
  p.on("error", () => console.warn(name + " failed to start"));
  p.on("exit", () => {
    if (children[name] === p) delete children[name];
  });
  return p;
}
function startApp(n) {
  if (apps[n]?.exitCode === null) return;
  const jar = path.join(runtime, "app-" + n + ".jar");
  fs.copyFileSync(path.join(root, "backend/target/payment-lab-1.0.0.jar"), jar);
  apps[n] = child("app-" + n, javaBin, ["-jar", jar], {
    APP_PORT: String(ports[n]),
    APP_INSTANCE: n,
    LAB_KEY: key,
    PAYMENT_CRYPTO_KEY: secret.crypto,
    PSP_SECRET: secret.psp,
    WEBHOOK_SECRET: secret.webhook,
  });
}
async function stopApp(n) {
  const p = apps[n];
  if (p && p.exitCode === null) {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    else p.kill();
    await Promise.race([new Promise((r) => p.once("exit", r)), pause(2000)]);
  }
  delete apps[n];
}
startApp("A");
startApp("B");
child("psp-server", process.execPath, [path.join(root, "psp/server.mjs")], {
  LAB_KEY: key,
});
// flow:Gateway.network
function tcp(kind, listen, target) {
  net
    .createServer((client) => {
      if (network[kind]) {
        client.destroy();
        return;
      }
      const up = net.connect(target, "127.0.0.1");
      sockets[kind].add(client);
      sockets[kind].add(up);
      const close = () => {
        client.destroy();
        up.destroy();
        sockets[kind].delete(client);
        sockets[kind].delete(up);
      };
      client.pipe(up);
      up.pipe(client);
      client.on("error", close);
      up.on("error", close);
      client.on("close", close);
      up.on("close", close);
    })
    .listen(listen, "127.0.0.1");
}
tcp("db", 55453, 55452);
tcp("redis", 56490, 56489);
tcp("pg", 18482, 18481);
function request(port, url, method = "GET", data) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: url,
        method,
        headers: { "X-Lab-Key": key, "Content-Type": "application/json" },
      },
      (res) => {
        let raw = "";
        res.on("data", (v) => (raw += v));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode,
              body: JSON.parse(raw || "null"),
            });
          } catch {
            reject(Error("Invalid upstream JSON"));
          }
        });
      },
    );
    r.on("error", reject);
    r.setTimeout(6000, () => r.destroy(Error("Upstream timeout")));
    if (data) r.write(JSON.stringify(data));
    r.end();
  });
}
function reply(res, status, b) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(b));
}
async function body(req) {
  let raw = "",
    size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 32768) throw Error("Body too large");
    raw += c;
  }
  return JSON.parse(raw || "{}");
}
const active = () => (apps.A?.exitCode === null ? "A" : "B"),
  tls = {
    key: fs.readFileSync(path.join(runtime, "dev-key.pem")),
    cert: fs.readFileSync(path.join(runtime, "dev-cert.pem")),
  };
https
  .createServer(tls, (req, res) => {
    const u = new URL(req.url, "https://localhost:18480");
    if (
      !["localhost:18480", "127.0.0.1:18480"].includes(req.headers.host) ||
      !["/checkout", "/health"].includes(u.pathname)
    ) {
      reply(res, 404, { code: "NOT_FOUND" });
      return;
    }
    if (
      req.method === "POST" &&
      req.headers.origin !== "https://localhost:18480"
    ) {
      reply(res, 403, { code: "ORIGIN_REJECTED" });
      return;
    }
    const up = http.request(
      {
        hostname: "127.0.0.1",
        port: 18481,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: "localhost:18480",
          cookie: (req.headers.cookie || "")
            .split(";")
            .filter((c) => c.trim().startsWith("__Host-psp_context="))
            .join(";"),
        },
      },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => reply(res, 503, { code: "PG_UNAVAILABLE" }));
    req.pipe(up);
  })
  .listen(18480, "127.0.0.1");
http
  .createServer((req, res) => {
    if (network.webhook) {
      req.socket.destroy();
      return;
    }
    if (req.url !== "/webhooks/local") {
      reply(res, 404, { code: "NOT_FOUND" });
      return;
    }
    const up = http.request(
      {
        hostname: "127.0.0.1",
        port: ports[active()],
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (r) => {
        if (req.headers["x-lab-drop-ack"] === "1") {
          r.resume();
          r.on("end", () => res.destroy());
          return;
        }
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => reply(res, 503, { code: "WEBHOOK_UNAVAILABLE" }));
    req.pipe(up);
  })
  .listen(8483, "127.0.0.1");
// flow:Gateway.responseLost
function lose(up, res) {
  up.resume();
  up.on("end", () => {
    drops.set(up.headers["x-request-id"], new Date().toISOString());
    res.destroy();
  });
}
const main = https.createServer(tls, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://localhost:18480",
  );
  try {
    const u = new URL(req.url, "https://localhost:8480");
    if (!["localhost:8480", "127.0.0.1:8480"].includes(req.headers.host)) {
      reply(res, 400, { code: "HOST_REJECTED" });
      return;
    }
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers.origin &&
      !["https://localhost:8480", "https://127.0.0.1:8480"].includes(
        req.headers.origin,
      )
    ) {
      reply(res, 403, { code: "ORIGIN_REJECTED" });
      return;
    }
    if (
      u.pathname.startsWith("/internal/") ||
      u.pathname.startsWith("/webhooks/")
    ) {
      reply(res, 404, { code: "NOT_FOUND" });
      return;
    }
    if (u.pathname.startsWith("/lab/")) {
      if (req.headers["x-lab-control"] !== "1") {
        reply(res, 403, { code: "LAB_CONTROL_REQUIRED" });
        return;
      }
      const run = u.searchParams.get("run");
      if (run && !/^[A-Za-z0-9_-]{1,80}$/.test(run)) {
        reply(res, 400, { code: "INVALID_RUN" });
        return;
      }
      if (u.pathname === "/lab/health") {
        const state = {};
        for (const n of ["A", "B"])
          try {
            state[n] = (await request(ports[n], "/health")).status;
          } catch {
            state[n] = 503;
          }
        let pg = 503;
        try {
          pg = (await request(18481, "/health")).status;
        } catch {}
        reply(res, 200, { apps: state, pg });
        return;
      }
      if (u.pathname === "/lab/runs" && req.method === "POST") {
        const b = await body(req),
          r = await request(ports[active()], "/internal/lab/runs", "POST", b);
        if (r.status === 200) await request(18481, "/internal/runs", "POST", b);
        reply(res, r.status, r.body);
        return;
      }
      if (u.pathname === "/lab/snapshot") {
        const results = await Promise.allSettled([
          request(ports[active()], "/internal/lab/snapshot?run=" + run),
          request(18481, "/internal/snapshot?run=" + run),
        ]);
        const values = results.map((r) =>
          r.status === "fulfilled" && r.value.status === 200
            ? r.value.body
            : { status: "unavailable" },
        );
        reply(res, 200, { merchant: values[0], pg: values[1] });
        return;
      }
      if (u.pathname === "/lab/traces") {
        const traces = [];
        for (const port of [ports.A, ports.B, 18481])
          try {
            const r = await request(
              port,
              port === 18481
                ? "/internal/traces?run=" + run
                : "/internal/lab/traces?run=" + run,
            );
            if (Array.isArray(r.body)) traces.push(...r.body);
          } catch {}
        const groups = new Map();
        for (const t of traces) {
          const id = t.operationId ? "op:" + t.operationId : t.id;
          let g = groups.get(id);
          if (!g) {
            g = { ...t, id, steps: [], startedAt: t.startedAt };
            groups.set(id, g);
          }
          g.steps.push(...t.steps);
          if (t.startedAt < g.startedAt) g.startedAt = t.startedAt;
          if (drops.has(t.id))
            g.steps.push({
              node: "Browser",
              action: "response_lost",
              message: "실제 상점 HTTP 응답 연결 유실",
              source: "Gateway.responseLost",
              at: drops.get(t.id),
              snapshot: { state: "UNKNOWN_TO_BROWSER" },
            });
        }
        reply(
          res,
          200,
          [...groups.values()]
            .map((g) => ({
              ...g,
              steps: g.steps.sort((a, b) => a.at.localeCompare(b.at)),
            }))
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
        );
        return;
      }
      if (
        ["/lab/fault", "/lab/price", "/lab/replay-outbox"].includes(
          u.pathname,
        ) &&
        req.method === "POST"
      ) {
        const b = await body(req);
        let r = { status: 200, body: { status: "updated" } };
        for (const n of ["A", "B"])
          if (apps[n]?.exitCode === null) {
            r = await request(
              ports[n],
              "/internal/lab/" + u.pathname.split("/").at(-1),
              "POST",
              b,
            );
            if (r.status !== 200) break;
          }
        reply(res, r.status, r.body);
        return;
      }
      if (
        [
          "/lab/psp-control",
          "/lab/deliver",
          "/lab/external-cancel",
          "/lab/duplicate",
        ].includes(u.pathname) &&
        req.method === "POST"
      ) {
        const b = await body(req),
          name =
            u.pathname.split("/").at(-1) === "psp-control"
              ? "control"
              : u.pathname.split("/").at(-1),
          r = await request(18481, "/internal/" + name, "POST", b);
        reply(res, r.status, r.body);
        return;
      }
      if (u.pathname === "/lab/network" && req.method === "POST") {
        const b = await body(req);
        if (!Object.hasOwn(network, b.target)) {
          reply(res, 400, { code: "INVALID_TARGET" });
          return;
        }
        network[b.target] = !!b.blocked;
        for (const socket of sockets[b.target] || []) socket.destroy();
        reply(res, 200, { network });
        return;
      }
      if (u.pathname === "/lab/app" && req.method === "POST") {
        const b = await body(req);
        if (!ports[b.node]) throw Error("Invalid app");
        if (b.action === "stop") await stopApp(b.node);
        else startApp(b.node);
        reply(res, 200, { status: b.action });
        return;
      }
      if (u.pathname === "/lab/redis-stop" && req.method === "POST") {
        stopRedis();
        reply(res, 200, { status: "stopped" });
        return;
      }
      if (u.pathname === "/lab/redis-restart" && req.method === "POST") {
        await restartRedis();
        reply(res, 200, { status: "restarted" });
        return;
      }
      if (u.pathname === "/lab/test" && req.method === "POST") {
        if (testProcess) {
          reply(res, 409, { code: "TEST_RUNNING" });
          return;
        }
        const b = await body(req);
        testProcess = child("browser-tests", process.execPath, [
          path.join(root, "node_modules/@playwright/test/cli.js"),
          "test",
        ]);
        testProcess.on("exit", () => (testProcess = null));
        reply(res, 202, { status: "started" });
        return;
      }
      if (u.pathname === "/lab/probe" && req.method === "POST") {
        if (probeProcess) {
          reply(res, 409, { code: "PROBE_RUNNING" });
          return;
        }
        probeProcess = child("runner-probe", process.execPath, [
          path.join(root, "test/runner-probe.mjs"),
        ]);
        probeProcess.on("exit", () => (probeProcess = null));
        reply(res, 202, { status: "started" });
        return;
      }
      if (u.pathname === "/lab/test-result") {
        let result = null;
        try {
          result = JSON.parse(
            fs.readFileSync(
              path.join(root, "test-results/summary.json"),
              "utf8",
            ),
          );
        } catch {}
        let probe = null;
        try {
          probe = JSON.parse(
            fs.readFileSync(
              path.join(root, "test-results/probe-summary.json"),
              "utf8",
            ),
          );
        } catch {}
        reply(res, 200, {
          running: !!testProcess,
          result,
          probe: { running: !!probeProcess, result: probe },
        });
        return;
      }
      reply(res, 404, { code: "NOT_FOUND" });
      return;
    }
    if (u.pathname.startsWith("/api/") || u.pathname === "/payment/return") {
      let n = req.headers["x-lab-node"] === "B" ? "B" : "A";
      if (apps[n]?.exitCode !== null) n = n === "A" ? "B" : "A";
      const headers = {
        ...req.headers,
        host: "localhost:8480",
        "x-lab-client-ip": "127.0.0.1",
      };
      delete headers["x-lab-key"];
      delete headers["x-psp-secret"];
      const up = http.request(
        {
          hostname: "127.0.0.1",
          port: ports[n],
          path: req.url,
          method: req.method,
          headers,
        },
        (r) => {
          if (
            req.headers["x-lab-drop-response"] === "1" &&
            req.method !== "GET"
          ) {
            lose(r, res);
            return;
          }
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        },
      );
      up.on("error", () => {
        if (!res.headersSent)
          reply(res, 503, {
            code: "APP_UNAVAILABLE",
            message: "상점 앱의 결과를 확인할 수 없습니다.",
          });
        else res.destroy();
      });
      up.setTimeout(20000, () => up.destroy());
      req.pipe(up);
      return;
    }
    const relative =
        u.pathname === "/flow-source.json"
          ? "public/flow-source.json"
          : u.pathname.startsWith("/assets/")
            ? "dist" + u.pathname
            : "dist/index.html",
      file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      reply(res, 404, { code: "BUILD_REQUIRED" });
      return;
    }
    res.setHeader(
      "Content-Type",
      file.endsWith(".html")
        ? "text/html; charset=utf-8"
        : file.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : file.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "application/json",
    );
    fs.createReadStream(file).pipe(res);
  } catch {
    if (!res.headersSent)
      reply(res, 503, {
        code: "OBSERVATION_UNAVAILABLE",
        message: "실제 상점·PG·저장소 결과를 확인할 수 없습니다.",
      });
    else res.destroy();
  }
});
main.listen(8480, "127.0.0.1", () =>
  console.log(
    "Payment lab https://localhost:8480 · independent PG https://localhost:18480",
  ),
);
fs.writeFileSync(
  path.join(runtime, "processes.json"),
  JSON.stringify(
    { root, gateway: process.pid, startedAt: new Date().toISOString() },
    null,
    2,
  ),
);
async function restartRedis() {
  network.redis = false;
  for (const s of sockets.redis) s.destroy();
  const dir = path.join(runtime, "redis/Redis-7.4.3-Windows-x64-cygwin");
  stopRedis();
  await pause(400);
  const data = path.join(runtime, "redis-data"),
    unix =
      "/cygdrive/" +
      data[0].toLowerCase() +
      data.slice(2).replaceAll("\\", "/");
  child("redis-restarted", path.join(dir, "redis-server.exe"), [
    "--bind",
    "127.0.0.1",
    "--port",
    "56489",
    "--dir",
    unix,
    "--appendonly",
    "yes",
  ]);
  await pause(500);
}
function stopRedis() {
  const dir = path.join(runtime, "redis/Redis-7.4.3-Windows-x64-cygwin");
  spawnSync(
    path.join(dir, "redis-cli.exe"),
    ["-p", "56489", "SHUTDOWN", "SAVE"],
    { windowsHide: true, stdio: "ignore" },
  );
}
function shutdown() {
  for (const p of Object.values(children))
    if (p.exitCode === null) {
      if (process.platform === "win32")
        spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      else p.kill();
    }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
