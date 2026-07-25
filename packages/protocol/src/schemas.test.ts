/**
 * Schema tests — the runtime-validation contract for the inbound surface.
 *
 * Guards three properties:
 *   1. COVERAGE — every ClientMessage variant has a schema (compile-time
 *      assertion on the discriminant literals, both directions).
 *   2. FIDELITY — a valid sample of every variant round-trips unchanged.
 *   3. FORWARD-COMPAT — unknown FIELDS are stripped (never rejected);
 *      unknown message TYPES are rejected; documented LIMITS are enforced.
 */

import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import type { ClientMessage } from "./types.js";
import { LIMITS } from "./types.js";
import {
  attachmentSchema,
  authMsgSchema,
  type clientMessageSchema,
  parseAuthMsg,
  parseClientMessage,
} from "./schemas.js";

// ── 1. Compile-time coverage: schema discriminants ⇔ ClientMessage types ─────

type SchemaTypes = z.infer<typeof clientMessageSchema>["type"];
type ClientTypes = ClientMessage["type"];
type MutualCover = [SchemaTypes] extends [ClientTypes]
  ? [ClientTypes] extends [SchemaTypes]
    ? true
    : never
  : never;

test("every ClientMessage variant has a schema and vice versa (compile-time)", () => {
  // This const fails to TYPECHECK when a variant is missing on either side —
  // the runtime assertion is just so the check lives in a visible test.
  const covered: MutualCover = true;
  expect(covered).toBe(true);
});

// ── 2. Fidelity: one valid sample per variant, keyed so adding a variant
//      without a sample is a compile error ─────────────────────────────────────

const samples: { [T in ClientTypes]: Extract<ClientMessage, { type: T }> } = {
  ping: { type: "ping", id: "r1" },
  "session.create": {
    type: "session.create",
    id: "r2",
    name: "demo",
    workdir: "/tmp/w",
    providerId: "pi",
  },
  "session.list": { type: "session.list", id: "r3" },
  "session.attach": { type: "session.attach", id: "r4", sessionId: "s1" },
  "session.detach": { type: "session.detach", id: "r5", sessionId: "s1" },
  "session.send": {
    type: "session.send",
    id: "r6",
    sessionId: "s1",
    text: "hello",
    attachments: [{ path: "notes.md" }, { path: "img.png", mimeType: "image/png", data: "aGk=" }],
    priority: "next",
  },
  "session.interrupt": { type: "session.interrupt", id: "r7", sessionId: "s1" },
  "session.approve": {
    type: "session.approve",
    id: "r8",
    sessionId: "s1",
    approvalId: "a1",
    approved: true,
    updatedInput: { answers: { "Which?": "B" } },
  },
  "session.ui_response": {
    type: "session.ui_response",
    id: "r25",
    sessionId: "s1",
    requestId: "u1",
    value: "Allow",
  },
  "session.part_action": {
    type: "session.part_action",
    id: "r26",
    sessionId: "s1",
    messageId: "m1",
    action: "retry-build",
    data: { target: "web" },
  },
  "session.commands": { type: "session.commands", id: "r27", sessionId: "s1" },
  "session.destroy": { type: "session.destroy", id: "r9", sessionId: "s1" },
  "session.set_mode": { type: "session.set_mode", id: "r10", sessionId: "s1", mode: "autonomous", maxTurns: 5 },
  "session.pin": { type: "session.pin", id: "r11", sessionId: "s1", path: "SPEC.md" },
  "session.unpin": { type: "session.unpin", id: "r12", sessionId: "s1", path: "SPEC.md" },
  "session.rotate": { type: "session.rotate", id: "r13", sessionId: "s1" },
  "session.search": { type: "session.search", id: "r14", query: "auth bug", scope: "all", limit: 5 },
  "session.set_model": { type: "session.set_model", id: "r15", sessionId: "s1", model: "opus", fallbackModel: null },
  "session.set_provider": {
    type: "session.set_provider",
    id: "r28",
    sessionId: "s1",
    providerId: "pi",
  },
  "session.fork": { type: "session.fork", id: "r16f", sessionId: "s1", name: "branch", providerId: "codex" },
  "scrollback.page": { type: "scrollback.page", id: "r16g", sessionId: "s1", beforeMessageId: "m-oldest", maxBytes: 65536 },
  "session.rename": { type: "session.rename", id: "r16", sessionId: "s1", name: "renamed" },
  "fs.list": { type: "fs.list", id: "r17", sessionId: "s1", path: "src" },
  "fs.read": { type: "fs.read", id: "r18", sessionId: "s1", path: "src/a.ts", maxBytes: 1024 },
  "fs.browse_dir": { type: "fs.browse_dir", id: "r19", path: "/home" },
  "claude.config": { type: "claude.config", id: "r20", sessionId: "s1" },
  "models.list": { type: "models.list", id: "r21", provider: "claude" },
  "session.export": { type: "session.export", id: "r22", sessionId: "s1", includeMemory: true, toFile: false },
  "session.import": {
    type: "session.import",
    id: "r23",
    source: { kind: "inline", bundle: { manifest: { v: 1 } } },
    targetWorkdir: "/tmp/w2",
    nameOverride: "imported",
  },
  "usage.daily": { type: "usage.daily", id: "r24", days: 30 },
  "settings.schema": { type: "settings.schema", id: "r29" },
  "settings.get": { type: "settings.get", id: "r30" },
  "settings.set": {
    type: "settings.set",
    id: "r31",
    patches: [
      { key: "memory.enabled", value: false },
      { key: "OPENAI_API_KEY", value: "sk-test" },
      { key: "compress.excludeCommands", value: ["git", "ls"] },
    ],
  },
  "pipeline.create": {
    type: "pipeline.create",
    id: "r32",
    name: "REQ-1",
    phases: [{ id: "impl", kind: "skill", skill: "implement", onFail: { action: "halt" } }],
    spec: "build X",
    workdir: "/tmp/repo",
  },
  "pipeline.list": { type: "pipeline.list", id: "r33" },
  "pipeline.get": { type: "pipeline.get", id: "r34", pipelineId: "p1" },
  "pipeline.advance": { type: "pipeline.advance", id: "r37", pipelineId: "p1" },
  "pipeline.answer": {
    type: "pipeline.answer",
    id: "r35",
    pipelineId: "p1",
    requestId: "exit:impl",
    approved: true,
    value: "LGTM",
  },
  "pipeline.abort": { type: "pipeline.abort", id: "r36", pipelineId: "p1" },
  "pipeline.revise": { type: "pipeline.revise", id: "r36b", pipelineId: "p1", requestId: "exit:impl", feedback: "add error handling" },
  "pipeline.pack.list": { type: "pipeline.pack.list", id: "r38" },
  "pipeline.registry.add": {
    type: "pipeline.registry.add",
    id: "r39",
    url: "git@github.com:highflame-ai/ai-factory.git",
    name: "ai-factory",
  },
  "pipeline.registry.refresh": { type: "pipeline.registry.refresh", id: "r39b", name: "ai-factory" },
  "pipeline.pack.install": { type: "pipeline.pack.install", id: "r40", packId: "aif-sdlc", trusted: false },
  "pipeline.pack.remove": { type: "pipeline.pack.remove", id: "r41", packId: "aif-sdlc" },
  "pipeline.pack.trust": { type: "pipeline.pack.trust", id: "r42", packId: "aif-sdlc", trusted: true },
  "pipeline.pack.select": { type: "pipeline.pack.select", id: "r43", packId: "aif-sdlc" },
};

describe("fidelity — valid samples round-trip unchanged", () => {
  for (const [type, sample] of Object.entries(samples)) {
    test(type, () => {
      const result = parseClientMessage(sample);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual(sample);
    });
  }
});

describe("pipeline.create — pack / role / optional phases", () => {
  test("accepts a pack reference with no phases", () => {
    const r = parseClientMessage({ type: "pipeline.create", id: "x", name: "R", pack: "aif-sdlc", workdir: "/tmp/repo" });
    expect(r.ok).toBe(true);
    if (r.ok && r.value.type === "pipeline.create") {
      expect(r.value.pack).toBe("aif-sdlc");
      expect(r.value.phases).toBeUndefined();
    }
  });

  test("accepts a phase carrying a capability role", () => {
    const r = parseClientMessage({
      type: "pipeline.create",
      id: "x",
      name: "R",
      phases: [{ id: "impl", kind: "skill", skill: "build", role: "implementer" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.value.type === "pipeline.create") expect(r.value.phases?.[0]?.role).toBe("implementer");
  });

  test("accepts create with neither phases nor pack (defaultPack resolved server-side)", () => {
    const r = parseClientMessage({ type: "pipeline.create", id: "x", name: "R" });
    expect(r.ok).toBe(true);
  });

  test("REJECTS both phases and pack (mutually exclusive)", () => {
    const r = parseClientMessage({
      type: "pipeline.create",
      id: "x",
      name: "R",
      phases: [{ id: "a", kind: "noop" }],
      pack: "aif-sdlc",
    });
    expect(r.ok).toBe(false);
  });
});

describe("session.fork — isolation fields survive validation (must not be stripped)", () => {
  // Regression guard: these fields were absent from the schema, so the wire
  // layer stripped them and the fork handler always saw `undefined` (isolation
  // forced, bind-mode + clean-base-fork dead).
  test("isolate / workdir / baseBranch round-trip through parseClientMessage", () => {
    const r = parseClientMessage({
      type: "session.fork",
      id: "f1",
      sessionId: "s1",
      isolate: false,
      workdir: "/tmp/repo",
      baseBranch: "main",
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.value.type === "session.fork") {
      expect(r.value.isolate).toBe(false);
      expect(r.value.workdir).toBe("/tmp/repo");
      expect(r.value.baseBranch).toBe("main");
    }
  });
});

describe("session.import — inline source requires a bundle", () => {
  test("inline without bundle is rejected", () => {
    const r = parseClientMessage({
      type: "session.import",
      id: "i1",
      source: { kind: "inline" },
      targetWorkdir: "/tmp/repo",
    });
    expect(r.ok).toBe(false);
  });
  test("inline with bundle is accepted", () => {
    const r = parseClientMessage({
      type: "session.import",
      id: "i2",
      source: { kind: "inline", bundle: { any: "thing" } },
      targetWorkdir: "/tmp/repo",
    });
    expect(r.ok).toBe(true);
  });
});

// ── 3. Forward-compat + rejection behaviour ───────────────────────────────────

describe("forward-compat", () => {
  test("unknown FIELDS on a known message are stripped, not rejected", () => {
    const result = parseClientMessage({
      type: "session.attach",
      id: "r1",
      sessionId: "s1",
      futureField: { anything: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ type: "session.attach", id: "r1", sessionId: "s1" });
      expect("futureField" in result.value).toBe(false);
    }
  });

  test("unknown message TYPES are rejected", () => {
    const result = parseClientMessage({ type: "session.teleport", id: "r1" });
    expect(result.ok).toBe(false);
  });

  test("non-object frames are rejected", () => {
    expect(parseClientMessage("hi").ok).toBe(false);
    expect(parseClientMessage(null).ok).toBe(false);
    expect(parseClientMessage(42).ok).toBe(false);
  });

  test("auth frame also strips unknown fields (future handshake additions)", () => {
    const result = parseAuthMsg({ type: "auth", token: "t", resume: { key: "k" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect("resume" in result.value).toBe(false);
  });
});

describe("required fields", () => {
  test("missing id is rejected", () => {
    expect(parseClientMessage({ type: "ping" }).ok).toBe(false);
  });

  test("missing sessionId is rejected", () => {
    expect(parseClientMessage({ type: "session.attach", id: "r1" }).ok).toBe(false);
  });

  test("empty session name is rejected (create + rename)", () => {
    expect(parseClientMessage({ type: "session.create", id: "r", name: "", workdir: "/w" }).ok).toBe(false);
    expect(parseClientMessage({ type: "session.rename", id: "r", sessionId: "s", name: "" }).ok).toBe(false);
  });

  test("multiple issues are summarized with a (+N more) suffix", () => {
    const result = parseClientMessage({ type: "session.create", id: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/\(\+\d+ more\)/);
  });
});

describe("LIMITS enforcement", () => {
  test("session.send text at the cap is accepted; over the cap is rejected", () => {
    const at = { type: "session.send", id: "r", sessionId: "s", text: "x".repeat(LIMITS.SEND_TEXT_MAX) };
    const over = { type: "session.send", id: "r", sessionId: "s", text: "x".repeat(LIMITS.SEND_TEXT_MAX + 1) };
    expect(parseClientMessage(at).ok).toBe(true);
    const rejected = parseClientMessage(over);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain("text");
  });

  test("attachments array over ATTACHMENTS_MAX is rejected", () => {
    const attachments = Array.from({ length: LIMITS.ATTACHMENTS_MAX + 1 }, (_, i) => ({ path: `f${i}` }));
    expect(parseClientMessage({ type: "session.send", id: "r", sessionId: "s", text: "t", attachments }).ok).toBe(false);
  });

  test("oversized name / query / model are rejected", () => {
    expect(
      parseClientMessage({ type: "session.create", id: "r", name: "n".repeat(LIMITS.NAME_MAX + 1), workdir: "/w" }).ok,
    ).toBe(false);
    expect(parseClientMessage({ type: "session.search", id: "r", query: "q".repeat(LIMITS.QUERY_MAX + 1) }).ok).toBe(false);
    expect(
      parseClientMessage({ type: "session.set_model", id: "r", sessionId: "s", model: "m".repeat(LIMITS.MODEL_MAX + 1) }).ok,
    ).toBe(false);
  });

  test("numeric bounds: search limit, usage days, fs.read maxBytes, set_mode maxTurns", () => {
    expect(parseClientMessage({ type: "session.search", id: "r", query: "q", limit: 0 }).ok).toBe(false);
    expect(parseClientMessage({ type: "session.search", id: "r", query: "q", limit: 101 }).ok).toBe(false);
    expect(parseClientMessage({ type: "usage.daily", id: "r", days: 366 }).ok).toBe(false);
    expect(parseClientMessage({ type: "fs.read", id: "r", sessionId: "s", path: "p", maxBytes: 0 }).ok).toBe(false);
    expect(parseClientMessage({ type: "session.set_mode", id: "r", sessionId: "s", mode: "autonomous", maxTurns: -1 }).ok).toBe(false);
  });
});

describe("attachments", () => {
  test("content and data are mutually exclusive", () => {
    expect(attachmentSchema.safeParse({ path: "f", content: "x", data: "eA==", mimeType: "text/plain" }).success).toBe(false);
  });

  test("data requires mimeType", () => {
    expect(attachmentSchema.safeParse({ path: "f", data: "eA==" }).success).toBe(false);
    expect(attachmentSchema.safeParse({ path: "f", data: "eA==", mimeType: "text/plain" }).success).toBe(true);
  });

  test("plain path-only and content attachments are valid", () => {
    expect(attachmentSchema.safeParse({ path: "f" }).success).toBe(true);
    expect(attachmentSchema.safeParse({ path: "f", content: "inline" }).success).toBe(true);
  });
});

describe("auth handshake", () => {
  test("minimal frame (legacy client) is valid", () => {
    const result = parseAuthMsg({ type: "auth", token: "jwt" });
    expect(result.ok).toBe(true);
  });

  test("full frame with version + capabilities + client is valid", () => {
    const frame = {
      type: "auth" as const,
      token: "jwt",
      protocolVersion: 1,
      capabilities: ["parts", "replay.chunked"],
      client: "codeoid-web",
    };
    const result = parseAuthMsg(frame);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(frame);
  });

  test("missing or empty token is rejected", () => {
    expect(parseAuthMsg({ type: "auth" }).ok).toBe(false);
    expect(parseAuthMsg({ type: "auth", token: "" }).ok).toBe(false);
  });

  test("malformed capabilities are rejected", () => {
    expect(parseAuthMsg({ type: "auth", token: "t", capabilities: "parts" }).ok).toBe(false);
    expect(parseAuthMsg({ type: "auth", token: "t", capabilities: [42] }).ok).toBe(false);
  });

  test("wrong type literal is rejected", () => {
    expect(authMsgSchema.safeParse({ type: "ping", token: "t" }).success).toBe(false);
  });
});

describe("session.ui_response payload exclusivity", () => {
  test("ambiguous payloads are rejected", () => {
    // Two payload fields at once.
    expect(
      parseClientMessage({
        type: "session.ui_response",
        id: "r1",
        sessionId: "s1",
        requestId: "u1",
        value: "x",
        cancelled: true,
      }).ok,
    ).toBe(false);
    // No payload field at all.
    expect(
      parseClientMessage({
        type: "session.ui_response",
        id: "r1",
        sessionId: "s1",
        requestId: "u1",
      }).ok,
    ).toBe(false);
  });

  test("each single-field payload is accepted", () => {
    for (const payload of [{ value: "x" }, { confirmed: false }, { cancelled: true }]) {
      const result = parseClientMessage({
        type: "session.ui_response",
        id: "r1",
        sessionId: "s1",
        requestId: "u1",
        ...payload,
      });
      expect(result.ok).toBe(true);
    }
  });
});
