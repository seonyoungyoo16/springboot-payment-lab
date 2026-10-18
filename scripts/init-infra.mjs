import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";
fs.mkdirSync(".runtime", { recursive: true });
if (!fs.existsSync(".runtime/secrets.json"))
  fs.writeFileSync(
    ".runtime/secrets.json",
    JSON.stringify(
      {
        crypto: crypto.randomBytes(32).toString("base64"),
        psp: crypto.randomBytes(32).toString("base64url"),
        webhook: crypto.randomBytes(32).toString("base64url"),
      },
      null,
      2,
    ),
  );
for (const [port, database] of [
  [55452, "merchant"],
  [55454, "psp"],
]) {
  const c = new pg.Client({
    host: "127.0.0.1",
    port,
    user: "paylab",
    database: "postgres",
  });
  await c.connect();
  if (
    !(await c.query("SELECT 1 FROM pg_database WHERE datname=$1", [database]))
      .rowCount
  )
    await c.query("CREATE DATABASE " + database);
  await c.end();
}
const c = new pg.Client({
  host: "127.0.0.1",
  port: 55454,
  user: "paylab",
  database: "psp",
});
await c.connect();
await c.query(fs.readFileSync("psp/schema.sql", "utf8"));
await c.end();
console.log(
  "Two independent project databases and persistent runtime keys prepared",
);
