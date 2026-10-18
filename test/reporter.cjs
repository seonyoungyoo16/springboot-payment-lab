const fs = require("node:fs");
const path = require("node:path");
module.exports = class Reporter {
  constructor() {
    this.tests = [];
    this.startedAt = new Date().toISOString();
  }
  onTestEnd(test, result) {
    this.tests.push({
      id: test.title.match(/^[A-Z]\d\d/)?.[0] || test.title.split(" ")[0],
      title: test.title.replace(/ @\w+/g, ""),
      status: result.status,
      duration: result.duration,
      error:
        result.status === "passed"
          ? null
          : "실패: 로컬 콘솔 결과를 확인하세요.",
    });
    this.save("running");
  }
  onEnd(result) {
    this.save(result.status);
  }
  save(status) {
    fs.mkdirSync("test-results", { recursive: true });
    fs.writeFileSync(
      path.resolve("test-results/summary.json.tmp"),
      JSON.stringify(
        {
          status,
          startedAt: this.startedAt,
          finishedAt: new Date().toISOString(),
          tests: this.tests,
        },
        null,
        2,
      ),
    );
    fs.renameSync(
      path.resolve("test-results/summary.json.tmp"),
      path.resolve("test-results/summary.json"),
    );
  }
};
