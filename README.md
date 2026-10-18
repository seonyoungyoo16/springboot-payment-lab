# Spring Boot Payment Lab

중복 승인, 거래 정합성, 전액·부분 취소, 결과 불명 복구를 **실제 상점 서버 A/B와 독립 Local PSP 서버**로 확인하는 학습 프로젝트다. 상점과 PG는 서로 다른 PostgreSQL 프로세스·데이터 디렉터리를 사용하고 HTTP로 통신한다. 기존 게시판·채팅·로그인·회원가입 서버와 DB를 공유하지 않는다.

공개 [포트폴리오 결제 체험](https://seonyoungyoo16.github.io/portfolio/#project/payment)은 브라우저 시뮬레이션이다. 이 저장소의 로컬 프로젝트에서 실제 HTTP, DB 커밋, Redis, 소켓 단절, 프로세스 종료를 검증한다. Local PSP는 직접 만든 실험 결제사이며 실제 카드망·금전 이동은 없다. 외부 PG 어댑터 X01~X04는 후속 범위다.

## 실행

검증 환경: Windows/PowerShell, JDK 21, Node.js 24, Git의 OpenSSL 또는 PATH의 openssl, tar. Docker는 필요 없다. 프로젝트 폴더의 경로에는 공백을 피한다.

```powershell
git clone https://github.com/seonyoungyoo16/springboot-payment-lab.git
cd springboot-payment-lab
node --version
java --version
npm ci
npx playwright install chromium
.\scripts\start-local.ps1
```

첫 실행은 Maven 3.9.9, PostgreSQL 17.11, Redis 7.4.3 Windows 배포본을 프로젝트 내부에 받는다. PostgreSQL/Redis 압축 파일의 고정 SHA-256을 검증한다. Redis Windows 배포본은 `redis-windows/redis-windows`의 Cygwin 배포본이다. 다른 프로젝트 설치를 복사하거나 참조하지 않는다.

상점 **https://localhost:8480**, 독립 PG 인증 **https://localhost:18480**. 로컬 자체 서명 인증서를 생성하므로 실습 브라우저에서 두 로컬 출처를 허용해야 한다. Playwright의 인증서 예외는 이 로컬 테스트 문맥에만 적용한다. 실습 계정 A/B/OPERATOR의 비밀번호는 화면의 `Payment!2026LongPass`다. 서버에서 Argon2id로 검증하며 로딩만으로 자동 로그인하지 않는다.

정상 경로는 로그인 → 주문 생성 → PG 인증 화면 → 명시적 결제 확정 → 승인 작업 결과 확인 → 부분/전액 취소다. 화면 오른쪽에서 상점/PG의 실제 관찰 시각과 데이터, 처리 흐름의 단계별 스냅샷, 파일·행·해시를 비교한다. 처리 기록은 완료한 실제 요청을 재생하며 가상 실시간 네트워크라고 표시하지 않는다. 브라우저 응답 본문 수신은 프런트엔드에서 별도로 기록한다.

```powershell
# 다른 터미널에서 실행. 실제 공유 장애를 주입하므로 동시에 돌리지 않는다.
node scripts/run-browser-suite.mjs
npm run test:backend
npm run check:coverage
npm run test:preview

# 앱만 종료, DB/Redis와 데이터 유지
.\scripts\stop-local.ps1 -KeepInfra
# 전체 프로젝트 프로세스 종료, 데이터는 보존
.\scripts\stop-local.ps1
# 다시 실행 / 기존 빌드를 그대로 실행
.\scripts\start-local.ps1 -SkipBuild
```

`node scripts/run-browser-suite.mjs`는 실제 화면의 전체 검증 버튼을 클릭해 64개를 실행하고 중복 실행의 409도 확인한다. CLI만 실행하려면 `npm run test:browser`. 전체 64개가 모두 통과한 경우에만 `docs/verification/browser.json`을 갱신한다. 의도적 실패 진단은 별도 보고서를 쓰며 금융 검증의 통과 수에 포함하지 않는다. 실패한 진단과 실제 테스트 실패를 화면에서 구분한다.

## 구조와 포트

| 역할 | 포트 | 영속 저장소 |
|---|---|---|
| 상점 HTTPS 게이트웨이 | 8480 | 정적 UI·역방향 프록시·로컬 실험 제어 |
| Spring Boot A/B | 8481/8482 | merchant PostgreSQL |
| 웹훅 수신 게이트웨이 | 8483 | 정상 앱으로 전달, TCP/ACK 유실 실험 |
| Local PSP HTTPS / 서버 | 18480/18481 | psp PostgreSQL |
| 상점→PG TCP 프록시 | 18482 | 실제 PG 도착 전 차단 |
| 상점 PostgreSQL / 프록시 | 55452/55453 | `.runtime/pg-merchant` |
| PSP PostgreSQL | 55454 | `.runtime/pg-psp` |
| Redis / 프록시 | 56489/56490 | `.runtime/redis-data`, AOF |

모든 리스너는 loopback이다. 게이트웨이의 `/lab`은 격리된 로컬 실험 제어이고 공개 배포용 관리자 API가 아니다. 내부 경로는 서버 간 임시 키를 검증한다. `.runtime/secrets.json`의 암호화·PG·웹훅 키는 처음 생성한 뒤 보존한다. 인증서·DB·로그·키·테스트 임시 파일은 Git에서 제외한다. 키를 지우면 이전 암호문을 읽을 수 없으므로 데이터와 함께 보관해야 한다.

## 지키는 경계

- `checkout_intent` 하나는 주문 하나. 동일 시도에는 canonical 승인 작업 하나. 클라이언트 키가 바뀌어도 같은 PG 작업에 연결한다.
- 승인/취소 작업, PG 키 암호문, job, 요청 키 매핑을 상점 트랜잭션에 접수한 뒤 worker가 전송한다. PG HTTP 동안 DB 행 잠금을 유지하지 않는다.
- 승인 A, 확정 취소 C, 미해결 예약 R을 구분한다. 결제 행 잠금과 예상 버전으로 `C + R + 신규 취소 ≤ A`를 판정한다. 같은 취소 키 재전송은 버전 검사 전에 원래 작업을 반환한다.
- PG 거래 ID가 유일한 append-only 원장이 사실의 기준이다. 원장·작업·주문·집계·outbox는 같은 트랜잭션에 반영한다. 영수증은 별도 inbox로 중복 소비를 방지하고 최신 결제 버전을 반영한다.
- UNKNOWN은 실패가 아니다. 예약을 유지하고 동일 작업을 조회한다. 작업의 실제 거래 식별 증거 없이 취소 금액만으로 성공을 판정하지 않는다. 외부 취소로 `C + R > A`가 되어도 실제 사실과 REVIEW_HELD 예약을 보존하고 신규 취소를 막는다.
- 종료 요청 중 늦은 승인이 확인되면 별도 보상 작업을 만든다. 미해결 효과가 없고 잔액이 0일 때 CLOSED다. 이미 수락한 주문은 단순 주문 기한 경과로 자동 환불하지 않는다.
- 자체 PSP 웹훅은 timestamp·raw body HMAC을 검증한 뒤 inbox를 커밋한다. 본문 순서를 믿지 않고 현재 PG 거래를 다시 조회한다. 외부 공급자의 서명 계약을 이 HMAC과 같다고 가정하지 않는다.
- lease는 작업 선점 수단이다. 이전 원격 요청이 취소되었다고 가정하지 않는다. 늦은 원격 사실은 거래 ID로 반영하고 진행 상태 갱신은 lease token으로 보호한다.

기본 정책은 주문 600초, 인증/최근 인증 300초, lease 20초, 원격 timeout 5초, 변경 재전송 최대 5회다. PG 멱등 키의 실험 보존 기간은 15일, 자동 변경 전송의 안전 기한은 최초 전송에서 최대 24시간이다. 자동 조회 예산 소진이나 안전 기한 경과는 REVIEW로 남긴다. `short`, `expiry`는 실제 시간 경과 테스트, `capacity`는 작은 공유 한도/대기열 테스트용 고정 정책이다. 소급해 정책을 바꾸지 않는다. 운영자 재개도 최초 PG 키·안전 기한을 보존한다.

## 검증과 소스

[설계 원본과 64개 시나리오](docs/DESIGN.md), [전체 브라우저 결과](docs/verification/browser.json), [별도 백엔드 12개 결과](docs/verification/backend.json).

P 8 / D 8 / T 8 / C 10 / W 8 / F 12 / S 6 / U 4 = 64. 주문·승인, 중복 방지, 거래 정합성, 취소/종료, 웹훅/대사, 실제 장애, 소유권/CSRF/입력, 관찰/반응형 화면을 포함한다. 백엔드 검사는 별도 DB 클러스터 식별, 암호문 보관, 작업/원장/outbox 연결, 예약·불명 유지, 양쪽 거래 ID, 누적 취소 합계와 유일 제약을 SQL로 확인한다. 성능 용량이나 실제 카드사 운영 승인을 보증하는 부하 검증은 이 결과에 포함하지 않는다.

`scripts/export-source.mjs`는 Java·PSP·게이트웨이·프런트엔드의 `flow:` 앵커 37개를 실제 파일·행·SHA-256과 함께 추출한다. `check:coverage`는 설계 ID 64개, 중복 없는 테스트 ID 64개, 전체 통과 보고서, 소스 해시/행을 대조한다.

| 읽을 파일 | 책임 |
|---|---|
| `PaymentService.java` | 소유권, canonical 승인, 취소 예약과 예상 버전 |
| `Workers.java` | durable job, lease, 조회/재전송, inbox·대사·projection |
| `PaymentProcessor.java` | 원장 유일성, 원자 반영, 예약 정산, 보상 |
| `PspClient.java` | 고정 PG 경로와 응답 결속 검증 |
| `psp/server.mjs`, `psp/schema.sql` | 별도 DB를 가진 실험 PG와 서명 웹훅 |
| `scripts/gateway.mjs` | 실제 TCP/응답 단절·앱 종료, 출처 분리 |

행 잠금의 의미는 [PostgreSQL 17 공식 문서](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS)를 기준으로 한다. 외부 어댑터를 구현할 때는 [Toss Payments 인증·멱등 헤더 계약](https://docs.tosspayments.com/reference/using-api/authorization)을 별도로 적용하고 X01~X04를 수행해야 한다. 현재 Local PSP가 그 외부 PG의 구현이라고 주장하지 않는다.
