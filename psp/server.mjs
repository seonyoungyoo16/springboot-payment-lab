import fs from "node:fs";
import http from "node:http";
const pendingQueries = new Map();
import crypto from "node:crypto";
import pg from "pg";
pg.types.setTypeParser(20, Number);
const pool = new pg.Pool({
    host: "127.0.0.1",
    port: 55454,
    user: "paylab",
    database: "psp",
    max: 8,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
  }),
  secrets = JSON.parse(fs.readFileSync(".runtime/secrets.json", "utf8")),
  labKey = process.env.LAB_KEY;
const traces = [],
  wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex"),
  hmac = (s) =>
    crypto.createHmac("sha256", secrets.psp).update(s).digest("hex"),
  equal = (a, b) =>
    typeof a === "string" &&
    typeof b === "string" &&
    a.length === b.length &&
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function seal(s) {
  const iv = crypto.randomBytes(12),
    c = crypto.createCipheriv(
      "aes-256-gcm",
      Buffer.from(hmac("psp-data"), "hex"),
      iv,
    );
  const data = Buffer.concat([c.update(s, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
}
function unseal(s) {
  const v = Buffer.from(s, "base64"),
    c = crypto.createDecipheriv(
      "aes-256-gcm",
      Buffer.from(hmac("psp-data"), "hex"),
      v.subarray(0, 12),
    );
  c.setAuthTag(v.subarray(12, 28));
  return Buffer.concat([c.update(v.subarray(28)), c.final()]).toString("utf8");
}
function fail(status, code) {
  throw Object.assign(Error(code), { status, code });
}
const validRun = (s) => {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(s || "")) fail(400, "INVALID_RUN");
  return s;
};
const uuid = (s) => {
  if (!/^[a-f0-9-]{36}$/i.test(s || "")) fail(400, "INVALID_ID");
  return s;
};
async function tx(work) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const v = await work(c);
    await c.query("COMMIT");
    return v;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
async function body(req) {
  let chunks = [],
    size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) fail(413, "BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return req.headers["content-type"]?.includes(
      "application/x-www-form-urlencoded",
    )
      ? Object.fromEntries(new URLSearchParams(raw))
      : JSON.parse(raw || "{}");
  } catch {
    fail(400, "INVALID_JSON");
  }
}
function reply(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end(JSON.stringify(data));
}
const policy = (name) =>
  name === "expiry"
    ? { auth: 10, key: 10, retry: 1 }
    : name === "short"
      ? { auth: 20, key: 1296000, retry: 1 }
      : { auth: 300, key: 1296000, retry: 5 };
async function config(run, c = pool) {
  return (await c.query("SELECT * FROM psp_runs WHERE id=$1", [run])).rows[0];
}
async function take(run, name) {
  const row = await tx(async (c) => {
    const r = (
      await c.query("SELECT controls FROM psp_runs WHERE id=$1 FOR UPDATE", [
        run,
      ])
    ).rows[0];
    if (!r?.controls[name]) return false;
    await c.query("UPDATE psp_runs SET controls=controls-$2 WHERE id=$1", [
      run,
      name,
    ]);
    return r.controls[name];
  });
  return row;
}
async function snapshot(c, p) {
  const transactions = (
    await c.query(
      'SELECT id,operation_id AS "operationId",kind,amount,occurred_at AS "occurredAt" FROM psp_transactions WHERE payment_id=$1 ORDER BY occurred_at,id',
      [p.id],
    )
  ).rows;
  return {
    paymentKey: p.id,
    attemptId: p.attempt_id,
    providerOrderId: p.provider_order_id,
    realm: p.realm_id,
    merchant: p.merchant,
    environment: p.environment,
    amount: p.amount,
    currency: p.currency,
    authState: p.auth_state,
    authUntil: p.auth_until,
    partialCancelable: p.partial_cancelable,
    captured: p.captured,
    canceled: p.canceled,
    approvedAt: p.approved_at,
    transactions,
  };
}
function tamper(s, controls) {
  s = structuredClone(s);
  if (controls["hide-operation-results"])
    for (const t of s.transactions) t.operationId = null;
  if (controls.tamper) {
    if (controls.tamper === "amount") s.amount++;
    if (controls.tamper === "currency") s.currency = "USD";
    if (controls.tamper === "merchant") s.merchant = "other";
    if (controls.tamper === "environment") s.environment = "live";
    if (controls.tamper === "order") s.providerOrderId = "foreign-order";
  }
  return s;
}
async function enqueue(c, p, operation, type) {
  const event = crypto.randomUUID();
  await c.query(
    "INSERT INTO psp_webhooks(id,realm_id,payment_id,attempt_id,event_type,operation_id) VALUES($1,$2,$3,$4,$5,$6)",
    [event, p.realm_id, p.id, p.attempt_id, type, operation],
  );
  return event;
}
// flow:Psp.createIntent
async function intent(b) {
  validRun(b.run);
  uuid(b.attemptId);
  if (
    !Number.isSafeInteger(b.amount) ||
    b.amount < 1 ||
    b.amount > 1000000 ||
    b.currency !== "KRW" ||
    !/^pay_[a-zA-Z0-9_-]{1,60}$/.test(b.providerOrderId) ||
    !/^https:\/\/localhost:8480\/payment\/return$/.test(b.returnUrl) ||
    !/^[A-Za-z0-9_-]{43}$/.test(b.ticket) ||
    !/^[A-Za-z0-9_-]{43}$/.test(b.state)
  )
    fail(400, "INVALID_INTENT");
  return tx(async (c) => {
    const r = (
      await c.query("SELECT * FROM psp_runs WHERE id=$1 FOR UPDATE", [b.run])
    ).rows[0];
    if (!r) fail(404, "RUN_REQUIRED");
    let p = (
      await c.query(
        "SELECT * FROM psp_payments WHERE realm_id=$1 AND attempt_id=$2 ORDER BY id LIMIT 1",
        [b.run, b.attemptId],
      )
    ).rows[0];
    if (!p) {
      const id = crypto.randomUUID();
      p = (
        await c.query(
          "INSERT INTO psp_payments(id,realm_id,attempt_id,provider_order_id,amount,currency,ticket_hash,auth_until,return_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          [
            id,
            b.run,
            b.attemptId,
            b.providerOrderId,
            b.amount,
            b.currency,
            hash(b.ticket),
            b.authUntil,
            seal(JSON.stringify({ state: b.state, returnUrl: b.returnUrl })),
          ],
        )
      ).rows[0];
    }
    if (
      p.amount !== b.amount ||
      p.provider_order_id !== b.providerOrderId ||
      !equal(p.ticket_hash, hash(b.ticket))
    )
      fail(409, "INTENT_CONFLICT");
    return { url: "https://localhost:18480/checkout?ticket=" + b.ticket };
  });
}
// flow:Psp.commitOperation
async function mutate(kind, b, key, trace) {
  uuid(b.operationId);
  uuid(b.paymentKey);
  if (!key || key.length > 300) fail(400, "KEY_REQUIRED");
  if (
    !Number.isSafeInteger(b.amount) ||
    b.amount < 1 ||
    b.amount > 1000000 ||
    b.currency !== "KRW"
  )
    fail(400, "INVALID_AMOUNT");
  const requestHash = hash(
    JSON.stringify({
      kind,
      paymentKey: b.paymentKey,
      amount: b.amount,
      currency: b.currency,
      reason: b.reason || null,
      operationId: b.operationId,
    }),
  );
  const outcome = await tx(async (c) => {
    const p = (
      await c.query("SELECT * FROM psp_payments WHERE id=$1 FOR UPDATE", [
        b.paymentKey,
      ])
    ).rows[0];
    if (!p) fail(404, "PAYMENT_NOT_FOUND");
    validRun(p.realm_id);
    trace.run = p.realm_id;
    const cfg = await config(p.realm_id, c),
      pol = policy(cfg.policy);
    await c.query(
      "INSERT INTO psp_call_log VALUES($1,$2,$3,clock_timestamp())",
      [crypto.randomUUID(), p.realm_id, kind],
    );
    const old = (
      await c.query(
        "SELECT * FROM psp_operations WHERE id=$1 OR (realm_id=$2 AND kind=$3 AND key_hash=$4) LIMIT 1",
        [b.operationId, p.realm_id, kind, hash(key)],
      )
    ).rows[0];
    if (old) {
      if (!equal(old.request_hash, requestHash))
        fail(409, "IDEMPOTENCY_CONFLICT");
      return { ...old.result, replayed: true };
    }
    if (cfg.controls["delay-" + kind])
      await wait(Number(cfg.controls["delay-" + kind]));
    let code = null,
      transactionId = null;
    if (
      p.currency !== b.currency ||
      (kind === "CONFIRM" && p.amount !== b.amount)
    )
      code = "AMOUNT_MISMATCH";
    if (kind === "CONFIRM") {
      if (p.auth_state === "PENDING") code = "AUTH_REQUIRED";
      if (new Date(p.auth_until) <= new Date() || p.auth_state === "EXPIRED")
        code = "AUTH_EXPIRED";
      if (
        p.auth_state === "DECLINED" ||
        p.auth_state === "CANCELED" ||
        p.auth_state === "SEALED_DENIED" ||
        p.instrument === "DECLINE"
      )
        code = "PAYMENT_DECLINED";
      if (p.captured) code = "ALREADY_CAPTURED";
    } else {
      if (!p.captured) code = "NOT_CAPTURED";
      if (p.canceled + b.amount > p.captured) code = "CANCEL_EXCEEDS_BALANCE";
      if (!p.partial_cancelable && b.amount !== p.captured - p.canceled)
        code = "PARTIAL_NOT_ALLOWED";
      if (p.instrument === "CANCEL_DECLINE") code = "CANCEL_DECLINED";
    }
    if (!code) {
      transactionId = crypto.randomUUID();
      await c.query(
        "INSERT INTO psp_transactions(id,realm_id,payment_id,operation_id,kind,amount) VALUES($1,$2,$3,$4,$5,$6)",
        [
          transactionId,
          p.realm_id,
          p.id,
          b.operationId,
          kind === "CONFIRM" ? "CAPTURE" : "CANCEL",
          b.amount,
        ],
      );
      if (kind === "CONFIRM")
        await c.query(
          "UPDATE psp_payments SET captured=amount,approved_at=clock_timestamp() WHERE id=$1",
          [p.id],
        );
      else
        await c.query(
          "UPDATE psp_payments SET canceled=canceled+$2 WHERE id=$1",
          [p.id, b.amount],
        );
      await enqueue(
        c,
        p,
        b.operationId,
        kind === "CONFIRM" ? "CAPTURED" : "CANCELED",
      );
    } else if (
      kind === "CONFIRM" &&
      ["PAYMENT_DECLINED", "AUTH_EXPIRED"].includes(code)
    )
      await c.query(
        "UPDATE psp_payments SET auth_state='SEALED_DENIED' WHERE id=$1",
        [p.id],
      );
    const fresh = (
        await c.query("SELECT * FROM psp_payments WHERE id=$1", [p.id])
      ).rows[0],
      result = {
        operationId: b.operationId,
        state: code ? "FAILED_FINAL" : "SUCCEEDED",
        failureCode: code,
        transactionId,
        payment: await snapshot(c, fresh),
      };
    await c.query(
      "INSERT INTO psp_operations(id,realm_id,payment_id,kind,amount,key_hash,request_hash,state,transaction_id,result,key_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,clock_timestamp()+($11 * interval '1 second'))",
      [
        b.operationId,
        p.realm_id,
        p.id,
        kind,
        b.amount,
        hash(key),
        requestHash,
        result.state,
        transactionId,
        JSON.stringify(result),
        pol.key,
      ],
    );
    return result;
  });
  trace.steps.push({
    node: "PG DB",
    action: "committed",
    message: "독립 PG 트랜잭션 커밋 · " + outcome.state,
    source: "Psp.commitOperation",
    at: new Date().toISOString(),
    snapshot: { state: outcome.state, amount: b.amount, kind },
  });
  return outcome;
}
function escaped(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1:18481"),
    trace = {
      id: crypto.randomUUID(),
      run: "unknown",
      instance: "PG",
      method: req.method,
      path: u.pathname,
      operationId: req.headers["x-correlation-id"] || null,
      startedAt: new Date().toISOString(),
      steps: [],
      status: 0,
    };
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "strict-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://localhost:8480; frame-ancestors 'none'; base-uri 'none'",
  );
  try {
    if (u.pathname === "/health") {
      reply(res, 200, { status: "up" });
      return;
    }
    if (u.pathname.startsWith("/internal/")) {
      if (!equal(req.headers["x-lab-key"], labKey))
        fail(403, "LAB_KEY_REQUIRED");
      const run = u.searchParams.get("run");
      if (u.pathname === "/internal/traces") {
        reply(
          res,
          200,
          traces.filter((t) => t.run === run),
        );
        return;
      }
      if (u.pathname === "/internal/runs") {
        const b = await body(req);
        await pool.query(
          "INSERT INTO psp_runs(id,policy) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [validRun(b.run), b.policy || "normal"],
        );
        reply(res, 200, { status: "ready" });
        return;
      }
      if (u.pathname === "/internal/control") {
        const b = await body(req);
        validRun(b.run);
        await pool.query("UPDATE psp_runs SET controls=$2::jsonb WHERE id=$1", [
          b.run,
          JSON.stringify(b.controls || {}),
        ]);
        reply(res, 200, { status: "updated" });
        return;
      }
      if (u.pathname === "/internal/snapshot") {
        validRun(run);
        const payments = (
            await pool.query(
              "SELECT id,attempt_id,provider_order_id,amount,currency,auth_state,captured,canceled,partial_cancelable,approved_at FROM psp_payments WHERE realm_id=$1 ORDER BY id",
              [run],
            )
          ).rows.map((p) => ({ ...p, id: hash(p.id).slice(0, 12) })),
          transactions = (
            await pool.query(
              "SELECT kind,amount,occurred_at FROM psp_transactions WHERE realm_id=$1 ORDER BY occurred_at",
              [run],
            )
          ).rows,
          webhooks = (
            await pool.query(
              "SELECT id,event_type,state,attempts,next_at FROM psp_webhooks WHERE realm_id=$1 ORDER BY created_at",
              [run],
            )
          ).rows,
          calls = (
            await pool.query(
              "SELECT kind,count(*)::int AS count FROM psp_call_log WHERE realm_id=$1 GROUP BY kind",
              [run],
            )
          ).rows;
        reply(res, 200, {
          observedAt: new Date().toISOString(),
          payments,
          transactions,
          webhooks,
          calls,
          pendingQueries: [...pendingQueries.values()]
            .filter((q) => q.run === run)
            .map(({ run, ...q }) => q),
        });
        return;
      }
      if (u.pathname === "/internal/deliver") {
        const b = await body(req);
        const r = await deliver(uuid(b.id), b.mode || "normal");
        reply(res, 200, r);
        return;
      }
      if (
        u.pathname === "/internal/external-cancel" ||
        u.pathname === "/internal/duplicate"
      ) {
        const b = await body(req);
        validRun(b.run);
        await tx(async (c) => {
          let p = (
            await c.query(
              "SELECT * FROM psp_payments WHERE attempt_id=$1 AND realm_id=$2 ORDER BY id LIMIT 1 FOR UPDATE",
              [uuid(b.attemptId), b.run],
            )
          ).rows[0];
          if (!p || !p.captured) fail(409, "CAPTURE_REQUIRED");
          if (u.pathname.endsWith("duplicate")) {
            const id = crypto.randomUUID();
            p = (
              await c.query(
                "INSERT INTO psp_payments(id,realm_id,attempt_id,provider_order_id,amount,currency,ticket_hash,auth_until,auth_state,captured,approved_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),'SEALED_DENIED',$5,clock_timestamp()) RETURNING *",
                [
                  id,
                  p.realm_id,
                  p.attempt_id,
                  p.provider_order_id,
                  p.amount,
                  p.currency,
                  hash(id),
                ],
              )
            ).rows[0];
            await c.query(
              "INSERT INTO psp_transactions(id,realm_id,payment_id,kind,amount) VALUES($1,$2,$3,'CAPTURE',$4)",
              [crypto.randomUUID(), p.realm_id, p.id, p.amount],
            );
          } else {
            if (
              !Number.isSafeInteger(b.amount) ||
              b.amount <= 0 ||
              b.amount > p.captured - p.canceled
            )
              fail(400, "INVALID_AMOUNT");
            await c.query(
              "UPDATE psp_payments SET canceled=canceled+$2 WHERE id=$1",
              [p.id, b.amount],
            );
            await c.query(
              "INSERT INTO psp_transactions(id,realm_id,payment_id,kind,amount) VALUES($1,$2,$3,'CANCEL',$4)",
              [crypto.randomUUID(), p.realm_id, p.id, b.amount],
            );
          }
          await enqueue(c, p, null, "EXTERNAL_CHANGE");
        });
        reply(res, 200, { status: "committed" });
        return;
      }
      fail(404, "NOT_FOUND");
    }
    if (u.pathname === "/checkout") {
      const b =
          req.method === "POST"
            ? await body(req)
            : Object.fromEntries(u.searchParams),
        ticket = b.ticket;
      if (!/^[A-Za-z0-9_-]{43}$/.test(ticket || ""))
        fail(400, "INVALID_TICKET");
      let p = (
        await pool.query("SELECT * FROM psp_payments WHERE ticket_hash=$1", [
          hash(ticket),
        ])
      ).rows[0];
      if (!p) fail(404, "TICKET_NOT_FOUND");
      trace.run = p.realm_id;
      if (p.auth_state !== "PENDING") fail(409, "TICKET_ALREADY_USED");
      if (new Date(p.auth_until) <= new Date()) fail(410, "AUTH_EXPIRED");
      const cookie = (req.headers.cookie || "")
        .split(";")
        .map((x) => x.trim().split("="))
        .find((x) => x[0] === "__Host-psp_context")?.[1];
      if (req.method === "GET") {
        const context =
            cookie && /^[A-Za-z0-9_-]{43}$/.test(cookie)
              ? cookie
              : crypto.randomBytes(32).toString("base64url"),
          csrf = crypto.randomBytes(32).toString("base64url");
        await pool.query(
          "UPDATE psp_payments SET context_hash=$2,csrf_hash=$3 WHERE id=$1",
          [p.id, hash(context), hash(csrf)],
        );
        res.setHeader(
          "Set-Cookie",
          "__Host-psp_context=" +
            context +
            "; Secure; HttpOnly; SameSite=Lax; Path=/",
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local PSP 인증</title><style>body{background:#0d1720;color:#d9e7ef;font:16px system-ui;margin:0;padding:10vh 6%}main{max-width:480px;margin:auto;background:#182b39;border:1px solid #36566c;border-radius:16px;padding:32px}small{color:#88b5cc}h1{font-size:28px}b{font-size:32px;color:#80d7c9}select,button{box-sizing:border-box;display:block;width:100%;padding:14px;background:#142431;color:#e4edef;border:1px solid #406077;border-radius:7px;margin-top:16px}p{color:#9eb7c8;line-height:1.8}</style><main><small>INDEPENDENT LOCAL PSP</small><h1>결제수단 인증</h1><b>${escaped(p.amount.toLocaleString("ko-KR"))}원</b><p>독립 PG 서버의 실험용 인증입니다.<br>이 단계에서는 승인·금전 이동이 없습니다.</p><form method="post"><input type="hidden" name="ticket" value="${ticket}"><input type="hidden" name="csrf" value="${csrf}"><label>실습 결제수단<select name="instrument" aria-label="실습 결제수단"><option value="APPROVE">정상 승인</option><option value="DECLINE">승인 종결 거절</option><option value="CANCEL_DECLINE">취소 종결 거절</option><option value="FULL_ONLY">전액 취소만 가능</option><option value="AUTH_DENY">인증 거절</option></select></label><button name="action" value="authenticate">인증하고 상점으로 돌아가기</button><button name="action" value="cancel">인증 취소</button></form></main></html>`,
        );
        return;
      }
      if (
        req.method !== "POST" ||
        req.headers.origin !== "https://localhost:18480" ||
        !equal(hash(cookie || ""), p.context_hash) ||
        !equal(hash(b.csrf || ""), p.csrf_hash)
      )
        fail(403, "AUTH_CONTEXT_MISMATCH");
      if (
        ![
          "APPROVE",
          "DECLINE",
          "CANCEL_DECLINE",
          "FULL_ONLY",
          "AUTH_DENY",
        ].includes(b.instrument)
      )
        fail(400, "INVALID_INSTRUMENT");
      const used = await pool.query(
        "UPDATE psp_payments SET auth_state=$2,instrument=$3,partial_cancelable=$4 WHERE id=$1 AND auth_state='PENDING'",
        [
          p.id,
          b.action === "cancel"
            ? "CANCELED"
            : b.instrument === "AUTH_DENY"
              ? "DECLINED"
              : "AUTHORIZED",
          b.instrument,
          b.instrument !== "FULL_ONLY",
        ],
      );
      if (used.rowCount !== 1) fail(409, "TICKET_ALREADY_USED");
      const ret = JSON.parse(unseal(p.return_ciphertext));
      res.writeHead(303, {
        Location: ret.returnUrl + "?state=" + encodeURIComponent(ret.state),
      });
      res.end();
      return;
    }
    if (!equal(req.headers["x-psp-secret"], secrets.psp))
      fail(401, "PSP_AUTH_REQUIRED");
    if (u.pathname === "/v1/intents" && req.method === "POST") {
      const b = await body(req);
      trace.run = b.run;
      reply(res, 200, await intent(b));
      return;
    }
    // flow:Psp.query
    if (u.pathname.startsWith("/v1/attempts/")) {
      const id = uuid(u.pathname.split("/").at(-1)),
        rows = (
          await pool.query(
            "SELECT * FROM psp_payments WHERE attempt_id=$1 ORDER BY approved_at NULLS FIRST,id",
            [id],
          )
        ).rows;
      if (!rows.length) {
        reply(res, 200, { payments: [] });
        return;
      }
      trace.run = rows[0].realm_id;
      const cfg = await config(trace.run);
      const payments = [];
      for (const p of rows)
        payments.push(tamper(await snapshot(pool, p), cfg.controls));
      const observed = {
        run: trace.run,
        observedAt: new Date().toISOString(),
        canceled: payments.reduce((n, p) => n + p.canceled, 0),
      };
      trace.steps.push({
        node: "PG DB",
        action: "snapshot_read",
        message: "PG 거래 스냅샷 조회 · 응답 시각과 구분",
        source: "Psp.query",
        at: observed.observedAt,
        snapshot: { canceled: observed.canceled },
      });
      if (cfg.controls["delay-query"]) {
        pendingQueries.set(trace.id, observed);
        await wait(Number(cfg.controls["delay-query"]));
        pendingQueries.delete(trace.id);
      }
      reply(res, 200, { payments });
      return;
    }
    if (u.pathname.startsWith("/v1/operations/")) {
      const id = uuid(u.pathname.split("/").at(-1)),
        op = (
          await pool.query("SELECT * FROM psp_operations WHERE id=$1", [id])
        ).rows[0];
      if (
        op &&
        (await config(op.realm_id)).controls["hide-operation-results"]
      ) {
        reply(res, 200, { state: "UNKNOWN" });
        return;
      }
      reply(
        res,
        200,
        op
          ? {
              state: op.state,
              transactionId: op.transaction_id,
              failureCode: op.result.failureCode,
              paymentKey: op.payment_id,
            }
          : { state: "NOT_FOUND" },
      );
      return;
    }
    // flow:Psp.voidAuthorization
    if (u.pathname === "/v1/void" && req.method === "POST") {
      const b = await body(req);
      const payments = await tx(async (c) => {
        const rows = (
          await c.query(
            "SELECT * FROM psp_payments WHERE attempt_id=$1 FOR UPDATE",
            [uuid(b.attemptId)],
          )
        ).rows;
        const values = [];
        for (const p of rows) {
          trace.run = p.realm_id;
          if (!p.captured) {
            await c.query(
              "UPDATE psp_payments SET auth_state='SEALED_DENIED' WHERE id=$1",
              [p.id],
            );
            p.auth_state = "SEALED_DENIED";
          }
          values.push(await snapshot(c, p));
        }
        return values;
      });
      reply(res, 200, { payments });
      return;
    }
    if (
      ["/v1/confirm", "/v1/cancel"].includes(u.pathname) &&
      req.method === "POST"
    ) {
      const b = await body(req),
        kind = u.pathname.endsWith("confirm") ? "CONFIRM" : "CANCEL";
      trace.operationId = b.operationId;
      const result = await mutate(
        kind,
        b,
        req.headers["idempotency-key"],
        trace,
      );
      const cfg = await config(trace.run);
      if (await take(trace.run, "drop-" + kind)) {
        trace.steps.push({
          node: "PG",
          action: "response_lost",
          message: "PG 커밋 후 실제 HTTP 응답 연결 제거",
          source: "Psp.commitOperation",
          at: new Date().toISOString(),
          snapshot: { state: result.state },
        });
        res.destroy();
        trace.status = 0;
        trace.responseLost = true;
        return;
      }
      if (cfg.controls["hold-response-" + kind])
        await wait(Number(cfg.controls["hold-response-" + kind]));
      if (result.payment) result.payment = tamper(result.payment, cfg.controls);
      reply(res, 200, result);
      return;
    }
    fail(404, "NOT_FOUND");
  } catch (e) {
    if (!res.headersSent)
      reply(res, e.status || 503, { code: e.code || "PG_UNAVAILABLE" });
    else res.destroy();
  } finally {
    trace.status = trace.responseLost ? 0 : res.statusCode;
    trace.finishedAt = new Date().toISOString();
    if (trace.run !== "unknown" && !u.pathname.startsWith("/internal/")) {
      traces.unshift(trace);
      if (traces.length > 2000) traces.pop();
    }
  }
});
server.listen(18481, "127.0.0.1", () =>
  console.log(
    "Independent Local PSP HTTP:18481 · own PostgreSQL:55454 · no real money",
  ),
);
// flow:Psp.deliverWebhook
async function deliver(id, mode = "normal") {
  const row = (await pool.query("SELECT * FROM psp_webhooks WHERE id=$1", [id]))
    .rows[0];
  if (!row) fail(404, "EVENT_NOT_FOUND");
  const timestamp = String(Date.now() + (mode === "expired" ? -600000 : 0)),
    payload = {
      eventId: row.id,
      run: row.realm_id,
      attemptId: row.attempt_id,
      operationId: row.operation_id,
      type: row.event_type,
    },
    raw = JSON.stringify(
      mode === "same-id-different-body"
        ? { ...payload, type: "ALTERED" }
        : payload,
    );
  let signature = crypto
    .createHmac("sha256", secrets.webhook)
    .update(timestamp + "." + raw)
    .digest("hex");
  if (mode === "bad-signature") signature = "0".repeat(64);
  const sent =
    mode === "changed-body" ? raw.replace(row.event_type, "ALTERED") : raw;
  await pool.query(
    "UPDATE psp_webhooks SET attempts=attempts+1,next_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
    [id],
  );
  try {
    const r = await fetch("http://127.0.0.1:8483/webhooks/local", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Psp-Timestamp": timestamp,
        "X-Psp-Signature": signature,
        ...(mode === "drop-ack" ? { "X-Lab-Drop-Ack": "1" } : {}),
      },
      body: sent,
      signal: AbortSignal.timeout(2000),
    });
    if (r.ok && mode === "normal")
      await pool.query(
        "UPDATE psp_webhooks SET state='DELIVERED' WHERE id=$1",
        [id],
      );
    return { status: r.status };
  } catch {
    return { status: 0 };
  }
}
let delivering = false;
setInterval(async () => {
  if (delivering) return;
  delivering = true;
  try {
    const rows = (
      await pool.query(
        "SELECT w.id,w.realm_id,r.controls FROM psp_webhooks w JOIN psp_runs r ON r.id=w.realm_id WHERE w.state='PENDING' AND w.next_at<=clock_timestamp() AND w.attempts<7 AND COALESCE(r.controls->>'hold-webhooks','false')<>'true' ORDER BY w.created_at LIMIT 4",
      )
    ).rows;
    for (const w of rows) if (!w.controls["hold-webhooks"]) await deliver(w.id);
  } catch {
  } finally {
    delivering = false;
  }
}, 400).unref();
