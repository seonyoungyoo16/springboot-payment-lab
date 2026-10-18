import fs from "node:fs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { chromium, request, expect } from "@playwright/test";
import {
  paid,
  api,
  lab,
  cancelBody,
  waitOrder,
  snapshot,
} from "./browser/helpers.ts";
const merchant = new pg.Client({
    host: "127.0.0.1",
    port: 55452,
    user: "paylab",
    database: "merchant",
  }),
  psp = new pg.Client({
    host: "127.0.0.1",
    port: 55454,
    user: "paylab",
    database: "psp",
  }),
  browser = await chromium.launch(),
  ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    baseURL: "https://localhost:8480",
  }),
  page = await ctx.newPage(),
  r = await request.newContext({
    baseURL: "https://localhost:8480",
    ignoreHTTPSErrors: true,
    baseURL: "https://localhost:8480",
  }),
  results = [];
await Promise.all([merchant.connect(), psp.connect()]);
let run, order;
async function check(id, title, fn) {
  try {
    await fn();
    results.push({ id, title, status: "passed" });
    console.log(id + " passed");
  } catch {
    results.push({ id, title, status: "failed" });
    throw Error(
      id + " backend verification failed; sensitive database rows are omitted",
    );
  }
}
const one = async (sql, args = []) => (await merchant.query(sql, args)).rows[0];
try {
  await check("B01", "상점과 PG는 서로 다른 PostgreSQL 클러스터", async () => {
    const a = (
        await merchant.query(
          "SELECT system_identifier FROM pg_control_system()",
        )
      ).rows[0].system_identifier,
      b = (await psp.query("SELECT system_identifier FROM pg_control_system()"))
        .rows[0].system_identifier;
    assert.notEqual(a, b);
  });
  await check(
    "B02",
    "독립 프로세스의 실제 PostgreSQL 버전과 DB 이름",
    async () => {
      for (const [c, name] of [
        [merchant, "merchant"],
        [psp, "psp"],
      ]) {
        const x = (
          await c.query(
            "SELECT current_database() AS db,current_setting('server_version_num')::int AS version",
          )
        ).rows[0];
        assert.equal(x.db, name);
        assert(x.version >= 170000);
      }
    },
  );
  ({ run, order } = await paid(page, r, "normal"));
  await check("B03", "논리 승인 작업 하나·키 매핑 복구", async () => {
    for (let i = 0; i < 3; i++) {
      const a = order.attempts[0];
      const res = await api(
        page,
        run,
        "attempts/" + a.id + "/confirm",
        "POST",
        {
          amount: 10000,
          currency: "KRW",
          providerOrderId: a.provider_order_id,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      assert.equal(res.data.id, order.operations[0].id);
    }
    assert.equal(
      Number(
        (
          await one(
            "SELECT count(*) n FROM payment_operations WHERE realm_id=$1",
            [run],
          )
        ).n,
      ),
      1,
    );
  });
  await check(
    "B04",
    "PG 키·ticket은 상점에서 암호문·HMAC으로 보관",
    async () => {
      const raw = (
        await psp.query("SELECT id FROM psp_payments WHERE realm_id=$1", [run])
      ).rows[0].id;
      const a = await one("SELECT * FROM payment_attempts WHERE realm_id=$1", [
          run,
        ]),
        p = await one("SELECT * FROM payments WHERE realm_id=$1", [run]),
        op = await one("SELECT * FROM payment_operations WHERE realm_id=$1", [
          run,
        ]);
      assert(!JSON.stringify([a, p, op]).includes(raw));
      assert(
        a.ticket_ciphertext &&
          p.provider_ciphertext &&
          op.provider_key_ciphertext,
      );
      assert.equal(p.provider_hash.length, 64);
      assert.notEqual(p.provider_hash, raw);
    },
  );
  await check("B05", "승인 원장·작업·주문·outbox 원자 상태", async () => {
    const x = await one(
      "SELECT o.state,p.approved_amount,p.canceled_amount,op.state op_state,(SELECT count(*) FROM payment_movements WHERE payment_id=p.id) movements,(SELECT count(*) FROM payment_outbox WHERE payment_id=p.id) outbox FROM orders o JOIN payments p ON p.id=o.accepted_payment_id JOIN payment_operations op ON op.order_id=o.id AND op.kind='CONFIRM' WHERE o.id=$1",
      [order.id],
    );
    assert.equal(x.state, "ACCEPTED");
    assert.equal(x.op_state, "SUCCEEDED");
    assert.equal(Number(x.movements), 1);
    assert.equal(Number(x.outbox), 1);
    assert.equal(Number(x.approved_amount), 10000);
  });
  let cancel;
  await check(
    "B06",
    "취소 접수는 C=0·R=3000 예약을 작업·job과 함께 커밋",
    async () => {
      await lab(r, "fault", { run, point: "hold-jobs" });
      cancel = cancelBody(order);
      assert.equal(
        (
          await api(
            page,
            run,
            "payments/" + order.payments[0].id + "/cancel",
            "POST",
            cancel,
          )
        ).status,
        202,
      );
      const x = await one(
        "SELECT p.canceled_amount,p.reserved_amount,r.state,j.operation_id FROM payments p JOIN cancel_reservations r ON r.payment_id=p.id JOIN operation_jobs j ON j.operation_id=r.operation_id WHERE p.realm_id=$1",
        [run],
      );
      assert.equal(Number(x.canceled_amount), 0);
      assert.equal(Number(x.reserved_amount), 3000);
      assert.equal(x.state, "ACTIVE");
      assert(x.operation_id);
    },
  );
  await check("B07", "PG 커밋 응답 제거·결과 불명은 예약 보존", async () => {
    await lab(r, "psp-control", {
      run,
      controls: {
        "drop-CANCEL": true,
        "hide-operation-results": true,
        "hold-webhooks": true,
      },
    });
    await lab(r, "fault", { run, point: "none" });
    await waitOrder(page, run, order.id, (o) =>
      o.operations.some((x) => x.kind === "CANCEL" && x.state === "UNKNOWN"),
    );
    const x = await one(
      "SELECT reserved_amount FROM payments WHERE realm_id=$1",
      [run],
    );
    assert.equal(Number(x.reserved_amount), 3000);
    assert.equal(
      Number(
        (
          await psp.query(
            "SELECT count(*) n FROM psp_transactions WHERE realm_id=$1 AND kind='CANCEL'",
            [run],
          )
        ).rows[0].n,
      ),
      1,
    );
  });
  await check(
    "B08",
    "강한 작업 식별 증거로 정산·같은 취소 키 재전송",
    async () => {
      await lab(r, "psp-control", { run, controls: { "hold-webhooks": true } });
      order = await waitOrder(
        page,
        run,
        order.id,
        (o) =>
          o.payments[0].canceled_amount === 3000 &&
          o.payments[0].reserved_amount === 0,
      );
      assert.equal(
        (
          await api(
            page,
            run,
            "payments/" + order.payments[0].id + "/cancel",
            "POST",
            cancel,
            "B",
          )
        ).status,
        200,
      );
      assert.equal(
        Number(
          (
            await psp.query(
              "SELECT count(*) n FROM psp_transactions WHERE realm_id=$1 AND kind='CANCEL'",
              [run],
            )
          ).rows[0].n,
        ),
        1,
      );
    },
  );
  await check(
    "B09",
    "남은 7000 전액 취소 후 누적 취소 10000·CLOSED",
    async () => {
      assert.equal(
        (
          await api(
            page,
            run,
            "payments/" + order.payments[0].id + "/cancel",
            "POST",
            cancelBody(order, 7000),
          )
        ).status,
        202,
      );
      order = await waitOrder(page, run, order.id, (o) => o.state === "CLOSED");
      assert.equal(order.payments[0].canceled_amount, 10000);
      assert.equal(order.payments[0].approved_amount, 10000);
      assert.equal(order.movements.length, 3);
    },
  );
  await check("B10", "원장 합계·PG 거래 ID·operation 연결 일치", async () => {
    const local = (
        await merchant.query(
          "SELECT provider_transaction_id,kind,amount,operation_id FROM payment_movements WHERE realm_id=$1",
          [run],
        )
      ).rows,
      remote = (
        await psp.query(
          "SELECT id,kind,amount,operation_id FROM psp_transactions WHERE realm_id=$1",
          [run],
        )
      ).rows;
    assert.equal(local.length, remote.length);
    for (const x of local) {
      const y = remote.find((y) => y.id === x.provider_transaction_id);
      assert(y);
      assert.equal(x.kind, y.kind);
      assert.equal(x.amount, y.amount);
      assert.equal(x.operation_id, y.operation_id);
    }
  });
  await check(
    "B11",
    "중복 outbox 재생 후 최신 영수증과 소비 기록",
    async () => {
      await lab(r, "replay-outbox", { run });
      await expect
        .poll(async () =>
          Number(
            (
              await one(
                "SELECT canceled FROM payment_receipts WHERE realm_id=$1",
                [run],
              )
            )?.canceled,
          ),
        )
        .toBe(10000);
      const x = await one(
        "SELECT count(*) n,count(DISTINCT event_id) d FROM projection_inbox WHERE event_id IN(SELECT id FROM payment_outbox WHERE realm_id=$1)",
        [run],
      );
      assert.equal(x.n, x.d);
      assert.equal(Number(x.n), 3);
    },
  );
  await check("B12", "DB 유일 제약은 원장 거래 ID 중복을 거부", async () => {
    await merchant.query("BEGIN");
    try {
      await merchant.query("SAVEPOINT duplicate_guard");
      const m = (
        await merchant.query(
          "SELECT * FROM payment_movements WHERE realm_id=$1 LIMIT 1",
          [run],
        )
      ).rows[0];
      let rejected = false;
      try {
        await merchant.query(
          "INSERT INTO payment_movements(id,realm_id,payment_id,operation_id,provider_transaction_id,kind,amount,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            crypto.randomUUID(),
            run,
            m.payment_id,
            m.operation_id,
            m.provider_transaction_id,
            m.kind,
            m.amount,
            m.occurred_at,
          ],
        );
      } catch (e) {
        rejected = e.code === "23505";
      }
      assert(rejected);
      await merchant.query("ROLLBACK TO SAVEPOINT duplicate_guard");
    } finally {
      await merchant.query("ROLLBACK");
    }
  });
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  if (run) await lab(r, "fault", { run, point: "none" }).catch(() => {});
  await Promise.allSettled([
    merchant.end(),
    psp.end(),
    r.dispose(),
    browser.close(),
  ]);
  fs.mkdirSync("docs/verification", { recursive: true });
  fs.writeFileSync(
    "docs/verification/backend.json",
    JSON.stringify(
      {
        status:
          results.length === 12 && results.every((x) => x.status === "passed")
            ? "passed"
            : "failed",
        finishedAt: new Date().toISOString(),
        tests: results,
      },
      null,
      2,
    ) + "\n",
  );
}
