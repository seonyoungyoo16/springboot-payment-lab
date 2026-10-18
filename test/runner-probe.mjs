import fs from "node:fs";
// No network mutation. This is deliberately a failing diagnostic, never a core test pass.
await new Promise((r) => setTimeout(r, 1600));
fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync(
  "test-results/probe-summary.json",
  JSON.stringify(
    {
      status: "failed",
      kind: "intentional-diagnostic",
      expectedFailure: true,
      tests: [
        {
          id: "PROBE",
          status: "failed",
          error: "의도적으로 실패한 진단입니다. 금융 검증 결과와 별도입니다.",
        },
      ],
      finishedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
process.exitCode = 1;
