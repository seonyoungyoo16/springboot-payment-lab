import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
const params = new URLSearchParams(location.search),
  initialRun = params.get("run") || "lab-" + Date.now(),
  CONTROL = { "X-Lab-Control": "1", "Content-Type": "application/json" };
const money = (n: any) => Number(n || 0).toLocaleString("ko-KR") + "원",
  left = (end: any, now: number) =>
    end ? Math.max(0, Math.ceil((Date.parse(end) - now) / 1000)) + "초" : "—";
type Step = {
  node: string;
  action: string;
  message: string;
  source: string;
  at: string;
  snapshot: any;
};
type Trace = {
  id: string;
  operationId?: string;
  method: string;
  path: string;
  instance: string;
  status: number;
  startedAt: string;
  steps: Step[];
};
function App() {
  const [run] = useState(initialRun),
    [auth, setAuth] = useState<any>(null),
    [user, setUser] = useState("A"),
    [password, setPassword] = useState("Payment!2026LongPass"),
    [checkout, setCheckout] = useState(""),
    [quantity, setQuantity] = useState("1"),
    [bootstrap, setBootstrap] = useState<any>(null),
    [order, setOrder] = useState<any>(null),
    [orderId, setOrderId] = useState(params.get("order") || ""),
    [cancelAmount, setCancelAmount] = useState("3000"),
    [cancelReason, setCancelReason] = useState("실습 취소"),
    [notice, setNotice] = useState("실험실을 준비하고 있습니다."),
    [busy, setBusy] = useState(false),
    [node, setNode] = useState("A"),
    [tab, setTab] = useState("service"),
    [snapshot, setSnapshot] = useState<any>(null),
    [observationError, setObservationError] = useState(""),
    [traces, setTraces] = useState<Trace[]>([]),
    [selected, setSelected] = useState<Trace | null>(null),
    [step, setStep] = useState(0),
    [playing, setPlaying] = useState(false),
    [sourceOpen, setSourceOpen] = useState(true),
    [sources, setSources] = useState<any>({}),
    [dropNext, setDropNext] = useState(false),
    [fault, setFault] = useState("none"),
    [pgControls, setPgControls] = useState<any>({}),
    [network, setNetwork] = useState<any>({}),
    [profile, setProfile] = useState("normal"),
    [testResult, setTestResult] = useState<any>(null),
    [now, setNow] = useState(Date.now());
  const csrf = useRef(""),
    lastRequest = useRef(""),
    lastOperation = useRef(""),
    drop = useRef(false),
    lastCancel = useRef<any>(null),
    orderRef = useRef(orderId),
    authRef = useRef<any>(null);
  const receipts = useRef(new Map<string, Step[]>());
  const current = selected?.steps[step],
    source = current ? sources[current.source] : null,
    payment =
      order?.payments?.find((p: any) => p.id === order.accepted_payment_id) ||
      order?.payments?.[0],
    attempt = order?.attempts?.at(-1),
    unresolved = order?.operations?.some((o: any) =>
      ["PENDING", "IN_FLIGHT", "UNKNOWN", "REVIEW"].includes(o.state),
    );
  function savedKey(scope: string) {
    const k = "payment:key:" + run + ":" + scope;
    let v = sessionStorage.getItem(k);
    if (!v) {
      v = crypto.randomUUID();
      sessionStorage.setItem(k, v);
    }
    return v;
  }
  async function lab(path: string, body?: any) {
    const r = await fetch("/lab/" + path, {
        method: body ? "POST" : "GET",
        headers: CONTROL,
        body: body ? JSON.stringify(body) : undefined,
      }),
      d = await r.json();
    if (!r.ok)
      throw Error(
        d.code === "TEST_RUNNING"
          ? "브라우저 검증이 이미 실행 중입니다."
          : `${r.status} · ${d.code || "OBSERVATION_UNAVAILABLE"}`,
      );
    return d;
  }
  async function prepare() {
    const r = await fetch("/api/context", {
        headers: { "X-Lab-Run": run, "X-Lab-Node": node },
      }),
      d = await r.json();
    if (!r.ok) throw Error(`${r.status} · 인증 문맥 확인 불가`);
    csrf.current = d.csrf;
  }
  async function api(
    path: string,
    method = "GET",
    body?: any,
    retry = true,
  ): Promise<any> {
    if (method !== "GET" && !csrf.current) await prepare();
    const requestId = crypto.randomUUID();
    let r: Response;
    try {
      const lose = method !== "GET" && drop.current;
      if (lose) {
        drop.current = false;
        setDropNext(false);
      }
      r = await fetch("/api/" + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Lab-Run": run,
          "X-Lab-Node": node,
          "X-Request-Id": requestId,
          ...(method === "GET" ? {} : { "X-CSRF-TOKEN": csrf.current }),
          ...(lose ? { "X-Lab-Drop-Response": "1" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw Error(
        "응답 연결 유실 · 결과를 추정하지 말고 같은 주문·작업을 확인하세요.",
      );
    }
    lastRequest.current = r.headers.get("x-request-id") || requestId;
    const d = await r.json();
    // flow:Frontend.receive
    if (method !== "GET") {
      const id = d.id && d.kind ? "op:" + d.id : lastRequest.current;
      const steps = receipts.current.get(id) || [];
      steps.push({
        node: "Browser",
        action: "response_received",
        message: "브라우저가 실제 HTTP " + r.status + " 응답 본문 수신",
        source: "Frontend.receive",
        at: new Date().toISOString(),
        snapshot: { status: r.status, state: d.kind ? d.state : undefined },
      });
      receipts.current.set(id, steps.slice(-20));
      while (receipts.current.size > 200)
        receipts.current.delete(receipts.current.keys().next().value!);
    }
    if (r.status === 403 && d.code === "CSRF_INVALID" && retry) {
      await prepare();
      return api(path, method, body, false);
    }
    if (!r.ok) throw Error(`${r.status} · ${d.code} · ${d.message || ""}`);
    if (d.id && d.kind) lastOperation.current = d.id;
    return { response: r, data: d };
  }
  async function loadOrder(id = orderRef.current) {
    if (!id) return;
    const r = await api("orders/" + id);
    setOrder(r.data);
    setOrderId(id);
    orderRef.current = id;
    sessionStorage.setItem(
      "payment:order:" + run + ":" + authRef.current?.user,
      id,
    );
    return r.data;
  }
  async function loadBootstrap() {
    const r = await api("bootstrap");
    setBootstrap(r.data);
    setCheckout((c) => c || r.data.checkoutIntent);
    return r.data;
  }
  async function observe() {
    try {
      const [s, serverTraces] = await Promise.all([
        lab("snapshot?run=" + run),
        lab("traces?run=" + run),
      ]);
      const t: Trace[] = serverTraces.map((t: Trace) => ({
        ...t,
        steps: [...t.steps, ...(receipts.current.get(t.id) || [])].sort(
          (a, b) => a.at.localeCompare(b.at),
        ),
      }));
      setSnapshot(s);
      setObservationError(
        s.merchant?.status === "unavailable" || s.pg?.status === "unavailable"
          ? "상점 또는 PG 저장소 확인 불가 · 이전 값이나 0으로 결과를 추정하지 마세요."
          : "",
      );
      setTraces(t);
      setSelected((old) => {
        if (old) return t.find((x: Trace) => x.id === old.id) || old;
        return (
          t.find((x: Trace) => x.operationId === lastOperation.current) ||
          t.find((x: Trace) => x.id === lastRequest.current) ||
          t.find((x: Trace) => x.steps.length > 1) ||
          null
        );
      });
    } catch (e) {
      setObservationError(String(e));
    }
  }
  async function task(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
      await observe();
      if (orderRef.current && authRef.current)
        try {
          await loadOrder();
        } catch {}
    }
  }
  async function login() {
    const r = await api("auth/login", "POST", { user, password });
    setAuth(r.data);
    authRef.current = r.data;
    csrf.current = "";
    await prepare();
    setCheckout("");
    const b = await loadBootstrap();
    const stored = sessionStorage.getItem(
        "payment:order:" + run + ":" + r.data.user,
      ),
      id =
        b.orders.find((o: any) => o.id === stored)?.id || b.orders[0]?.id || "";
    setOrder(null);
    orderRef.current = id;
    setOrderId(id);
    if (id) await loadOrder(id);
    setNotice(`로그인됨 · ${r.data.user}`);
  }
  async function confirm() {
    if (!attempt) return;
    const body = {
      amount: order.amount,
      currency: order.currency,
      providerOrderId: attempt.provider_order_id,
      idempotencyKey: savedKey("confirm:" + attempt.id),
    };
    const r = await api("attempts/" + attempt.id + "/confirm", "POST", body);
    lastOperation.current = r.data.id;
    setSelected(null);
    setStep(0);
    setPlaying(true);
    setNotice(
      `${r.response.status} · 승인 작업 ${r.data.state} · 접수와 PG 확정은 별도입니다.`,
    );
  }
  async function cancel(full = false, replay = false) {
    if (!payment) return;
    const body = replay
      ? lastCancel.current
      : {
          amount: full
            ? payment.approved_amount - payment.canceled_amount
            : Number(cancelAmount),
          currency: order.currency,
          reason: cancelReason,
          expectedPaymentVersion: payment.version,
          idempotencyKey: crypto.randomUUID(),
        };
    if (!body) throw Error("재전송할 취소 요청이 없습니다.");
    lastCancel.current = body;
    const r = await api("payments/" + payment.id + "/cancel", "POST", body);
    lastOperation.current = r.data.id;
    setSelected(null);
    setStep(0);
    setPlaying(true);
    setNotice(
      `${r.response.status} · 취소 작업 ${r.data.state} · 예약과 확정 취소를 구분합니다.`,
    );
  }
  useEffect(() => {
    void (async () => {
      try {
        await lab("runs", {
          run,
          ...(params.get("profile") ? { policy: params.get("profile") } : {}),
        });
        setSources(await (await fetch("/flow-source.json")).json());
        await prepare();
        const r = await fetch("/api/auth/me", {
          headers: { "X-Lab-Run": run },
        });
        if (r.ok) {
          const a = await r.json();
          setAuth(a);
          authRef.current = a;
          const b = await loadBootstrap();
          const id =
            params.get("order") ||
            sessionStorage.getItem("payment:order:" + run + ":" + a.user) ||
            b.orders[0]?.id;
          if (id) await loadOrder(id);
          setNotice(
            params.get("pgError")
              ? "PG 인증 확인 실패 · " + params.get("pgError")
              : params.get("returned")
                ? "PG 인증 확인됨 · 결제 확정 POST 전에는 승인되지 않습니다."
                : "기존 로그인과 주문을 복구했습니다.",
          );
        } else if (r.status === 401)
          setNotice("실험실 준비 완료 · 실습 계정으로 로그인하세요.");
        else throw Error("인증 상태 확인 불가");
        history.replaceState(
          null,
          "",
          "/?run=" +
            run +
            (orderRef.current ? "&order=" + orderRef.current : ""),
        );
        await observe();
      } catch (e) {
        setNotice((e as Error).message);
      }
    })();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const t = setInterval(() => {
      void observe();
      if (orderRef.current && authRef.current)
        void loadOrder().catch((e) =>
          setObservationError("주문 상태 확인 불가 · " + (e as Error).message),
        );
    }, 2000);
    return () => clearInterval(t);
  }, [node]);
  useEffect(() => {
    if (!playing || !selected) return;
    const t = setTimeout(() => {
      if (step < selected.steps.length - 1) setStep(step + 1);
      else setPlaying(false);
    }, 850);
    return () => clearTimeout(t);
  }, [playing, selected, step]);
  const cancelDisabled =
    busy ||
    !payment ||
    payment.sync_state !== "CURRENT" ||
    payment.approved_amount === payment.canceled_amount;
  return (
    <main>
      <div className="top">
        <a href="https://seonyoungyoo16.github.io/portfolio/#project/payment">
          ← 포트폴리오
        </a>
        <span>ACTUAL BACKEND · PAYMENT LAB</span>
        <small>run {run}</small>
        <button onClick={() => location.reload()}>실험실 다시 연결</button>
      </div>
      <header className="intro">
        <div>
          <span className="eyebrow">
            SPRING BOOT · POSTGRESQL · REDIS · INDEPENDENT PSP
          </span>
          <h1>
            한 번의 결제를,
            <br />
            <em>끝까지 확인합니다.</em>
          </h1>
          <p>승인·원장·취소·복구를 실제 상점과 독립 PG의 거래로 비교하세요.</p>
        </div>
        <aside>
          <strong>실제 백엔드 실험실</strong>
          <p>
            상점 A·B와 PG의 별도 PostgreSQL을 사용합니다.
            <br />
            실제 카드망·금전 이동은 발생하지 않습니다.
          </p>
          <label>
            처리 서버
            <select
              aria-label="처리 서버"
              value={node}
              onChange={(e) => setNode(e.target.value)}
            >
              <option>A</option>
              <option>B</option>
            </select>
          </label>
        </aside>
      </header>
      <nav className="tabs" aria-label="실험실 패널">
        {[
          ["service", "서비스"],
          ["pg", "PG"],
          ["flow", "흐름·소스"],
          ["data", "데이터"],
          ["test", "검증"],
        ].map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="workspace">
        <div
          className={
            "service-column pane " + (tab === "service" ? "mobile-active" : "")
          }
        >
          <section className="panel service" aria-label="주문과 결제 서비스">
            <div className="panel-head">
              <h2>주문과 결제</h2>
              <span>{auth ? "USER " + auth.user : "LOGIN REQUIRED"}</span>
            </div>
            <label>
              실습 사용자
              <select
                aria-label="실습 사용자"
                value={user}
                onChange={(e) => setUser(e.target.value)}
              >
                <option>A</option>
                <option>B</option>
                <option>OPERATOR</option>
              </select>
            </label>
            <label>
              실습 비밀번호
              <input
                type="password"
                aria-label="실습 비밀번호"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <div className="actions">
              <button disabled={busy} onClick={() => task(login)}>
                실습 계정 로그인
              </button>
              <button
                disabled={busy || !auth}
                onClick={() =>
                  task(async () => {
                    await api("auth/reauth", "POST", { password });
                    csrf.current = "";
                    await prepare();
                    setNotice("기존 수단 재확인 완료");
                  })
                }
              >
                기존 수단 재확인
              </button>
              <button
                disabled={busy || !auth}
                onClick={() =>
                  task(async () => {
                    await api("auth/logout", "POST", {});
                    authRef.current = null;
                    setAuth(null);
                    setOrder(null);
                    setOrderId("");
                    orderRef.current = "";
                    csrf.current = "";
                    await prepare();
                    setNotice("로그아웃됨");
                  })
                }
              >
                로그아웃
              </button>
            </div>
            <div className="auth-state">
              {auth
                ? "로그인됨 · " + auth.user + " · " + auth.role
                : "로그인 필요"}
            </div>
            <p className="subtle">
              실습 상품 · {money(bootstrap?.price || 10000)} / 개 · 주문 생성 뒤
              가격을 고정합니다.
            </p>
            <label>
              주문 수량
              <input
                type="number"
                aria-label="주문 수량"
                min="1"
                max="10"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </label>
            <div className="actions">
              <button
                disabled={busy || !auth}
                onClick={() =>
                  task(async () => {
                    const r = await api("orders", "POST", {
                      checkoutIntent: checkout,
                      product: "LAB_PRODUCT",
                      quantity: Number(quantity),
                      currency: "KRW",
                      idempotencyKey: savedKey("order:" + checkout),
                    });
                    await loadOrder(r.data.id);
                    setNotice(
                      `${r.response.status} · 주문 생성 · PG 승인 없음`,
                    );
                    setSelected(null);
                    setStep(0);
                    await loadBootstrap();
                  })
                }
              >
                주문 생성
              </button>
              <button
                disabled={busy || !auth}
                onClick={() =>
                  task(async () => {
                    const r = await api("checkout-intents", "POST", {});
                    setCheckout(r.data.checkoutIntent);
                    setOrder(null);
                    setOrderId("");
                    orderRef.current = "";
                    setNotice("명시적으로 새 구매 의도를 만들었습니다.");
                  })
                }
              >
                별도 새 주문 시작
              </button>
            </div>
            {bootstrap?.orders?.length > 0 && (
              <label>
                본인 주문
                <select
                  aria-label="본인 주문 선택"
                  value={orderId}
                  onChange={(e) =>
                    task(async () => {
                      await loadOrder(e.target.value);
                      setNotice("본인 주문 조회 · 금융 명령 없음");
                    })
                  }
                >
                  <option value="">주문 선택</option>
                  {bootstrap.orders.map((o: any) => (
                    <option key={o.id} value={o.id}>
                      {o.id.slice(0, 8)} · {money(o.amount)} · {o.state}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {order && (
              <>
                <div className="flow-state">
                  <strong data-testid="order-state">
                    {order.state}
                    {order.close_intent ? " · " + order.close_intent : ""}
                  </strong>
                  <small>
                    주문 {order.id.slice(0, 8)} · {money(order.amount)} · 기한{" "}
                    {left(order.expires_at, now)} · 버전 {order.version}
                  </small>
                </div>
                <div className="actions">
                  <button
                    disabled={
                      busy || !auth || order.state !== "OPEN" || unresolved
                    }
                    onClick={() =>
                      task(async () => {
                        const r = await api(
                          "orders/" + order.id + "/attempts",
                          "POST",
                          { provider: "local" },
                        );
                        location.assign(r.data.url);
                      })
                    }
                  >
                    PG 인증 화면 열기
                  </button>
                  <button
                    disabled={
                      busy || !attempt || attempt.state === "AUTH_PENDING"
                    }
                    onClick={() => task(confirm)}
                  >
                    결제 확정 요청
                  </button>
                  <button
                    disabled={busy || !attempt}
                    onClick={() => task(confirm)}
                  >
                    같은 승인 요청 재전송
                  </button>
                </div>
                <p className="subtle">
                  PG 인증과 결제 승인, 상점 반영은 별개입니다. 접수 202를 결제
                  완료로 표시하지 않습니다.
                </p>
                <div className="actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      task(async () => {
                        await loadOrder();
                        setNotice(
                          "현재 주문·작업 결과를 조회했습니다. 새 승인 없음",
                        );
                      })
                    }
                  >
                    주문·결과 확인
                  </button>
                  <button
                    disabled={busy || order.state === "CLOSED"}
                    onClick={() =>
                      task(async () => {
                        const r = await api(
                          "orders/" + order.id + "/close",
                          "POST",
                          {
                            reason: "USER_CANCEL",
                            idempotencyKey: savedKey("close:" + order.id),
                          },
                        );
                        setNotice(
                          `${r.response.status} · 주문 종료 요청 · 미해결 승인은 확인 후 보상합니다.`,
                        );
                      })
                    }
                  >
                    주문 종료 요청
                  </button>
                </div>
                <div
                  className={
                    "payment-summary " +
                    (payment?.sync_state === "REVIEW" ? "error" : "")
                  }
                  data-testid="payment-summary"
                >
                  <b>{payment ? payment.money_state : "금전 효과 없음"}</b>
                  <span>
                    승인 {money(payment?.approved_amount)} · 확정 취소{" "}
                    {money(payment?.canceled_amount)}
                  </span>
                  <span>
                    미해결 예약 {money(payment?.reserved_amount)} · 잔액{" "}
                    {money(
                      (payment?.approved_amount || 0) -
                        (payment?.canceled_amount || 0),
                    )}
                  </span>
                  <small>
                    {payment
                      ? "동기화 " + payment.sync_state
                      : "PG 승인 확인 전"}{" "}
                    · 주문 수락{" "}
                    {order.accepted_payment_id ? "확인됨" : "미확정"}
                  </small>
                </div>
                <div className="operation-list">
                  {order.operations?.map((o: any) => (
                    <article key={o.id}>
                      <b>
                        {o.kind} · {o.state}
                      </b>
                      <small>
                        {o.id.slice(0, 8)} · {money(o.amount)} · 전송{" "}
                        {o.attempts} / 확인 {o.queries}
                        {o.failure_code ? " · " + o.failure_code : ""}
                      </small>
                    </article>
                  ))}
                </div>
              </>
            )}
            <p role="status" className="notice">
              {notice}
            </p>
          </section>
          <section className="panel" aria-label="결제 취소">
            <h2>전액·부분 취소</h2>
            <p className="subtle">
              취소액을 먼저 예약합니다. 결과 불명에서는 예약을 유지하고 새
              취소를 차단합니다.
            </p>
            <label>
              부분 취소 금액
              <input
                aria-label="부분 취소 금액"
                type="number"
                min="1"
                value={cancelAmount}
                onChange={(e) => setCancelAmount(e.target.value)}
              />
            </label>
            <label>
              취소 사유
              <input
                aria-label="취소 사유"
                maxLength={200}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
              />
            </label>
            <div className="actions">
              <button
                disabled={cancelDisabled}
                onClick={() => task(() => cancel(false))}
              >
                부분 취소 요청
              </button>
              <button
                disabled={cancelDisabled}
                onClick={() => task(() => cancel(true))}
              >
                남은 금액 전액 취소
              </button>
              <button
                disabled={busy || !lastCancel.current}
                onClick={() => task(() => cancel(false, true))}
              >
                같은 취소 요청 재전송
              </button>
            </div>
            <p className="subtle">
              PG 취소 확정은 카드사의 최종 청구 변경·환급 완료와 구분합니다.
              최근 인증이 오래되면 기존 수단으로 재확인하세요.
            </p>
          </section>
        </div>
        <section
          className={
            "panel flow pane " + (tab === "flow" ? "mobile-active" : "")
          }
          aria-label="실제 처리 흐름"
        >
          <div className="panel-head">
            <h2>실행 기록과 실제 소스</h2>
            <span>
              {selected ? `${step + 1}/${selected.steps.length}` : "READY"}
            </span>
          </div>
          <select
            aria-label="실행 기록 선택"
            value={selected?.id || ""}
            onChange={(e) => {
              setSelected(traces.find((t) => t.id === e.target.value) || null);
              setStep(0);
              setPlaying(false);
            }}
          >
            <option value="">완료된 실제 실행 기록 선택</option>
            {traces.map((t) => (
              <option key={t.id} value={t.id}>
                {t.operationId
                  ? "작업 " + t.operationId.slice(0, 8)
                  : t.method + " " + t.path}{" "}
                · {t.instance} · {t.status}
              </option>
            ))}
          </select>
          <p className="subtle">
            완료된 실제 실행 재생입니다. 전송 시작·PG 커밋·상점 커밋·브라우저
            수신을 구분합니다.
          </p>
          <div className="actions">
            <button
              disabled={!selected}
              onClick={() => {
                if (step === (selected?.steps.length || 0) - 1) setStep(0);
                setPlaying(!playing);
              }}
            >
              {playing ? "흐름 일시 정지" : "흐름 재생"}
            </button>
            <button
              disabled={!selected}
              onClick={() => {
                setPlaying(false);
                setStep(Math.min(step + 1, (selected?.steps.length || 1) - 1));
              }}
            >
              다음 단계
            </button>
            <button
              disabled={!selected}
              onClick={() => {
                setPlaying(false);
                setStep((selected?.steps.length || 1) - 1);
              }}
            >
              마지막 단계
            </button>
          </div>
          <div className="current-step">
            <strong>
              {current?.message || "실제 주문을 생성해 처리 기록을 확인하세요."}
            </strong>
            <small>
              {current ? current.node + " · " + current.action : "ACTUAL I/O"}
            </small>
          </div>
          <svg
            viewBox="0 0 640 340"
            role="img"
            aria-label="브라우저·서버·Redis·상점 DB·PG·PG DB 처리 흐름"
          >
            <path
              d="M85 130H280L500 50M280 130H500M280 130V255H455L570 255"
              fill="none"
              stroke="#3b6278"
              strokeWidth="2"
            />
            {[
              ["Browser", 85, 130, "BROWSER"],
              ["Server", 280, 130, "SERVER " + node],
              ["Redis", 500, 50, "REDIS"],
              ["DB", 500, 130, "MERCHANT DB"],
              ["PG", 280, 255, "LOCAL PSP"],
              ["PG DB", 550, 255, "PSP DB"],
            ].map(([id, x, y, label]) => (
              <g key={id} transform={`translate(${x},${y})`}>
                <rect
                  x="-68"
                  y="-26"
                  width="136"
                  height="52"
                  rx="8"
                  fill={current?.node === id ? "#314d3e" : "#152c3b"}
                  stroke={current?.node === id ? "#8ed4ad" : "#486f87"}
                />
                <text y="4" textAnchor="middle" fill="#b7d5e7" fontSize="10">
                  {label}
                </text>
              </g>
            ))}
          </svg>
          <ol className="steps">
            {selected?.steps.map((s, i) => (
              <li key={i}>
                <button
                  aria-current={step === i ? "step" : undefined}
                  onClick={() => {
                    setPlaying(false);
                    setStep(i);
                  }}
                >
                  {i + 1} · {s.message}
                  <small>{s.node}</small>
                </button>
              </li>
            ))}
          </ol>
          {current && Object.keys(current.snapshot || {}).length > 0 && (
            <pre className="step-snapshot">
              {JSON.stringify(current.snapshot, null, 2)}
            </pre>
          )}
          <button
            className="source-toggle"
            aria-expanded={sourceOpen}
            onClick={() => setSourceOpen(!sourceOpen)}
          >
            현재 단계 실제 소스 {sourceOpen ? "닫기" : "열기"}
          </button>
          {sourceOpen &&
            (source ? (
              <div className="source">
                <small>
                  {source.file}:{source.line}
                </small>
                <pre>
                  {source.snippet.split("\n").map((line: string, i: number) => (
                    <div key={i}>
                      <span>{source.line + i}</span>
                      <code>{line || " "}</code>
                    </div>
                  ))}
                </pre>
                <small>SHA-256 {source.sha256}</small>
              </div>
            ) : (
              <p className="subtle">소스가 연결된 실제 단계를 선택하세요.</p>
            ))}
        </section>
        <aside
          className={
            "panel data pane " + (tab === "data" ? "mobile-active" : "")
          }
          aria-label="상점 데이터 관찰"
        >
          <div className="panel-head">
            <h2>상점 DB·Redis 관찰</h2>
            <small>{snapshot?.merchant?.observedAt || "확인 전"}</small>
          </div>
          <p className="subtle">
            관찰은 금융 명령과 만료를 갱신하지 않습니다. 저장된 작업·금전 거래를
            읽습니다.
          </p>
          {observationError && (
            <p className="observation-error">
              관찰 확인 불가 · {observationError}
            </p>
          )}
          <div className="counts">
            {Object.entries(snapshot?.merchant?.counts || {}).map(([k, v]) => (
              <div key={k}>
                <span>{k}</span>
                <strong>{String(v)}</strong>
              </div>
            ))}
          </div>
          {[
            ["orders", "주문"],
            ["operations", "승인·취소 작업과 lease"],
            ["payments", "금전 합계"],
            ["reservations", "미해결 예약"],
            ["movements", "금전 변동 원장"],
            ["inbox", "웹훅 inbox"],
            ["outbox", "후속 outbox"],
            ["receipts", "영수증 projection"],
            ["cases", "대사 확인 건"],
            ["limits", "Redis 제한 TTL"],
          ].map(([key, title]) => (
            <details
              key={key}
              open={["operations", "payments", "reservations"].includes(key)}
            >
              <summary>{title}</summary>
              <pre>
                {JSON.stringify(snapshot?.merchant?.[key] || [], null, 2)}
              </pre>
            </details>
          ))}
        </aside>
        <section
          className={
            "panel pg-observer pane " + (tab === "pg" ? "mobile-active" : "")
          }
          aria-label="독립 PG 데이터 관찰"
        >
          <div className="panel-head">
            <h2>독립 PG 거래와 웹훅</h2>
            <small>{snapshot?.pg?.observedAt || "확인 전"}</small>
          </div>
          <p className="subtle">
            상점과 다른 PostgreSQL 프로세스입니다. 각 관찰 시각을 따로 표시하며
            금융 효과를 직접 비교합니다.
          </p>
          {[
            ["payments", "PG 인증·승인·취소"],
            ["transactions", "PG 금전 거래"],
            ["webhooks", "PG 웹훅 전달"],
            ["calls", "PG 변경 HTTP 수신"],
          ].map(([key, title]) => (
            <details key={key} open>
              <summary>{title}</summary>
              <pre>{JSON.stringify(snapshot?.pg?.[key] || [], null, 2)}</pre>
            </details>
          ))}
        </section>
        <section
          className={
            "panel tests pane " + (tab === "test" ? "mobile-active" : "")
          }
          aria-label="장애와 실제 브라우저 검증"
        >
          <h2>장애와 실제 브라우저 검증</h2>
          <p className="subtle">
            격리된 로컬 실험 제어입니다. TCP 차단은 프로젝트 A·B의 공유 경로에
            적용하므로 테스트는 순차 실행합니다.
          </p>
          <label>
            새 실행 정책
            <select
              aria-label="새 실행 정책"
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
            >
              <option value="normal">기본 10분 주문</option>
              <option value="short">짧게 60초 주문</option>
              <option value="expiry">만료 15초 / 키 10초</option>
            </select>
          </label>
          <button
            onClick={() =>
              location.assign("/?run=lab-" + Date.now() + "&profile=" + profile)
            }
          >
            새 실험 실행
          </button>
          <label>
            지정 중단 지점
            <select
              aria-label="지정 중단 지점"
              value={fault}
              onChange={(e) => setFault(e.target.value)}
            >
              {[
                "none",
                "hold-jobs",
                "hold-after-claim",
                "hold-apply",
                "hold-apply-commit",
                "before-confirm-commit",
                "after-confirm-commit",
                "before-cancel-commit",
                "after-cancel-commit",
                "before-apply-commit",
                "hold-projection",
              ].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <button
            onClick={() =>
              task(async () => {
                await lab("fault", { run, point: fault });
                setNotice("지정 처리 지점 적용: " + fault);
              })
            }
          >
            처리 지점 적용
          </button>
          <label className="check">
            <input
              type="checkbox"
              checked={dropNext}
              onChange={(e) => {
                setDropNext(e.target.checked);
                drop.current = e.target.checked;
              }}
            />
            다음 상점 변경 응답 연결 유실
          </label>
          <div className="actions">
            {["db", "redis", "pg", "webhook"].map((target) => (
              <button
                key={target}
                onClick={() =>
                  task(async () => {
                    const blocked = !network[target];
                    await lab("network", { target, blocked });
                    setNetwork((n: any) => ({ ...n, [target]: blocked }));
                    setNotice(
                      target + " 실제 TCP " + (blocked ? "차단" : "복구"),
                    );
                  })
                }
              >
                {target} {network[target] ? "연결 복구" : "연결 차단"}
              </button>
            ))}
          </div>
          <div className="actions">
            {["A", "B"].map((n) => (
              <button
                key={n}
                onClick={() =>
                  task(async () => {
                    await lab("app", { node: n, action: "stop" });
                    setNotice(n + " 앱 실제 종료");
                  })
                }
              >
                {n} 앱 종료
              </button>
            ))}
            {["A", "B"].map((n) => (
              <button
                key={n}
                onClick={() =>
                  task(async () => {
                    await lab("app", { node: n, action: "start" });
                    setNotice(n + " 앱 시작 요청");
                  })
                }
              >
                {n} 앱 재시작
              </button>
            ))}
          </div>
          <h3>PG 응답과 웹훅</h3>
          <div className="actions">
            {[
              "hold-webhooks",
              "drop-CONFIRM",
              "drop-CANCEL",
              "hide-operation-results",
            ].map((k) => (
              <button
                key={k}
                aria-pressed={!!pgControls[k]}
                onClick={() =>
                  task(async () => {
                    const next = { ...pgControls, [k]: !pgControls[k] };
                    await lab("psp-control", { run, controls: next });
                    setPgControls(next);
                    setNotice("PG 실험 제어 " + k + " " + !!next[k]);
                  })
                }
              >
                {k} {pgControls[k] ? "ON" : "OFF"}
              </button>
            ))}
            <button
              onClick={() =>
                task(async () => {
                  await lab("psp-control", { run, controls: {} });
                  setPgControls({});
                  setNotice("PG 실험 제어 해제");
                })
              }
            >
              PG 제어 해제
            </button>
          </div>
          {snapshot?.pg?.webhooks?.map((w: any) => (
            <div className="actions" key={w.id}>
              <small>
                {w.event_type} · {w.id.slice(0, 8)} · {w.state}
              </small>
              <button
                onClick={() =>
                  task(async () => {
                    const r = await lab("deliver", { id: w.id });
                    setNotice("실제 웹훅 전달 HTTP " + r.status);
                  })
                }
              >
                웹훅 {w.id.slice(0, 8)} 전달
              </button>
            </div>
          ))}
          {snapshot?.merchant?.cases?.map((c: any) => (
            <div className="actions" key={c.id}>
              <small>
                {c.reason} · {c.state}
              </small>
              <button
                disabled={busy}
                onClick={() =>
                  task(async () => {
                    const r = await api(
                      "reconciliation/" + c.id + "/resume",
                      "POST",
                      { reason: "실습 운영자 확인 후 복구 재개" },
                    );
                    setNotice(r.response.status + " · 운영 복구 재개");
                  })
                }
              >
                확인 건 {c.id.slice(0, 8)} 복구 재개
              </button>
            </div>
          ))}
          <div className="actions">
            <button
              disabled={!!testResult?.running}
              onClick={() =>
                task(async () => {
                  await lab("test", {});
                  setTestResult({ running: true, result: null });
                  setNotice("실제 브라우저 전체 검증 시작");
                })
              }
            >
              브라우저 전체 검증 실행
            </button>
            <button
              disabled={!!testResult?.probe?.running}
              onClick={() =>
                task(async () => {
                  await lab("probe", {});
                  setTestResult(await lab("test-result"));
                  setNotice("의도적 실패 진단 시작 · 실제 금융 테스트와 별도");
                })
              }
            >
              의도적 실패 진단 실행
            </button>
            <button
              onClick={() =>
                task(async () => setTestResult(await lab("test-result")))
              }
            >
              검증 결과 새로고침
            </button>
          </div>
          <p data-testid="runner-state">
            {testResult?.running
              ? "브라우저 검증 실행 중"
              : testResult?.result?.status === "passed" &&
                  testResult.result.tests?.length === 64
                ? "브라우저 검증 통과"
                : testResult?.result?.status === "failed"
                  ? "브라우저 검증 실패"
                  : testResult?.result
                    ? "브라우저 검증 미판정 · 전체 64개 완료 결과를 확인하세요."
                    : "브라우저 검증 미실행"}
          </p>
          <p data-testid="probe-state">
            {testResult?.probe?.running
              ? "의도적 실패 진단 실행 중"
              : testResult?.probe?.result?.status === "failed"
                ? "의도적 실패 진단 완료 · 예상된 실패"
                : "의도적 실패 진단 미실행"}
          </p>
          <pre className="test-result">
            {testResult
              ? JSON.stringify(testResult, null, 2)
              : "아직 검증 결과를 조회하지 않았습니다."}
          </pre>
        </section>
      </div>
      <footer>
        실제 백엔드·독립 PG 검증 · 승인·취소 원장과 결과 불명을 구분합니다.
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
