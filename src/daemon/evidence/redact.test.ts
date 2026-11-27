import { describe, expect, test } from "bun:test";
import { redactOutput } from "./redact";

describe("redactOutput", () => {
  test("keeps what a worker needs to repair a failure", () => {
    const log = [
      "exit code: 1",
      "--- PASS: TestParseHeader (0.00s)",
      "--- FAIL: TestTokenizerHandlesUnicode (0.01s)",
      "FAIL src/daemon/pipeline/session-manager.routines.test.ts",
      "    at Object.<anonymous> (/home/u/repo/src/very_long_component_name_for_testing.ts:42:7)",
      "commit 3f9c2a1b8e7d6c5b4a3928170f6e5d4c3b2a1908",
      "expected 2 received 3",
    ].join("\n");
    expect(redactOutput(log)).toBe(log);
  });

  test("masks known credential shapes and secret-named values", () => {
    const out = redactOutput(
      [
        "Authorization: Bearer abcdefgh.ijklmnop-qrstuv",
        "export GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ",
        "using key sk-ant-api03-0123456789abcdefghijklmn",
        "DATABASE_PASSWORD='hunter2-is-secret'",
        "connecting to postgres://app:s3cretpass@db.internal:5432/app",
        "aws AKIAABCDEFGHIJKLMNOP",
      ].join("\n"),
    );
    for (const secret of ["ijklmnop", "ghp_0123", "sk-ant-api03", "hunter2", "s3cretpass", "AKIAABCDEF"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("db.internal:5432");
  });

  test("a PEM block longer than any scan window is masked whole", () => {
    const body = Array.from({ length: 60 }, (_, i) => `MIIBVwIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA${String(i).padStart(4, "0")}`).join("\n");
    const out = redactOutput(`before\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\nafter`);
    expect(out).not.toContain("MIIBVwIBADAN");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  test("a secret deep inside a very long line is still masked", () => {
    const line = `${"x".repeat(1_790)} password=hunter2Secret!x ${"y".repeat(500)}`;
    expect(redactOutput(line)).not.toContain("hunter2Secret");
  });
});
