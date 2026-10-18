import fs from "node:fs";
import crypto from "node:crypto";
const dir = "backend/src/main/java/dev/portfolio/paymentlab",
  result = {};
for (const file of [
  ...fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".java"))
    .map((f) => dir + "/" + f),
  "scripts/gateway.mjs",
  "psp/server.mjs",
  "frontend/main.tsx",
]) {
  const text = fs.readFileSync(file, "utf8"),
    lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = line.match(/flow:([\w.]+)/);
    if (m)
      result[m[1]] = {
        file,
        line: i + 2,
        sha256: crypto.createHash("sha256").update(text).digest("hex"),
        snippet: lines.slice(i + 1, i + 61).join("\n"),
      };
  });
}
fs.mkdirSync("public", { recursive: true });
fs.writeFileSync(
  "public/flow-source.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(Object.keys(result).length + " actual source anchors");
