import { describe, it, expect } from "vitest";

import { classifyFleetTool, fleetVerb } from "./fleet-cards";
import type { ToolInfo } from "../protocol/types";

function tool(name: string, input?: unknown): ToolInfo {
  return {
    toolId: "t1",
    name,
    state: { phase: "completed", output: "", success: true },
    ...(input === undefined ? {} : { input }),
  } as ToolInfo;
}

const fleet = (verb: string, input?: unknown) =>
  tool(`mcp__codeoid_fleet__${verb}`, input);

const valueOf = (card: ReturnType<typeof classifyFleetTool>, label: string) =>
  card?.fields.find((f) => f.label === label)?.value;

describe("fleetVerb", () => {
  it("strips the MCP server prefix and ignores ordinary tools", () => {
    expect(fleetVerb("mcp__codeoid_fleet__fleet_spawn")).toBe("fleet_spawn");
    expect(fleetVerb("Bash")).toBeNull();
    // A different MCP server must not be mistaken for the fleet.
    expect(fleetVerb("mcp__codeoid_memory__recall")).toBeNull();
  });
});

describe("classifyFleetTool", () => {
  it("returns null for a non-fleet tool so it keeps its normal rendering", () => {
    expect(classifyFleetTool(tool("Bash", { command: "ls" }))).toBeNull();
  });

  it("reads fleet_find as a resolve, quoting the query", () => {
    const card = classifyFleetTool(fleet("fleet_find", { query: "the authz fix" }))!;
    expect(card.kind).toBe("resolve");
    expect(card.sendClass).toBe(false);
    expect(card.summary).toContain("the authz fix");
    expect(valueOf(card, "query")).toBe("the authz fix");
  });

  it("reads fleet_spawn as a dispatch with shape, workdir basename and backend", () => {
    const card = classifyFleetTool(
      fleet("fleet_spawn", {
        shape: "scout",
        workdir: "/home/me/Workspace/codeoid",
        task: "Read README.md and report",
        provider: "claude",
        model: "opus",
      }),
    )!;
    expect(card.kind).toBe("dispatch");
    expect(card.sendClass).toBe(true);
    // The header stays short; the full path is still a field.
    expect(card.summary).toBe("Spawn scout in codeoid");
    expect(valueOf(card, "workdir")).toBe("/home/me/Workspace/codeoid");
    expect(valueOf(card, "backend")).toBe("claude · opus");
    expect(card.fields.find((f) => f.label === "task")?.block).toBe(true);
  });

  it("keeps a partial backend rather than dropping it", () => {
    const only = classifyFleetTool(fleet("fleet_spawn", { provider: "qwen" }))!;
    expect(valueOf(only, "backend")).toBe("qwen");
    const none = classifyFleetTool(fleet("fleet_spawn", {}))!;
    expect(valueOf(none, "backend")).toBeUndefined();
  });

  it("reads fleet_send with the schema's own field names", () => {
    // Matches the zod schema in src/daemon/fleet.ts: session / message / shape.
    const send = classifyFleetTool(
      fleet("fleet_send", { session: "studio-870", message: "run the linter", shape: "scout" }),
    )!;
    expect(send.kind).toBe("dispatch");
    expect(send.summary).toBe("Send to studio-870");
    expect(valueOf(send, "shape")).toBe("scout");
    expect(send.fields.find((f) => f.label === "message")?.block).toBe(true);

    expect(classifyFleetTool(fleet("fleet_interrupt", { session: "y" }))!.summary).toBe(
      "Interrupt y",
    );
  });

  it("still shows a target when the model proposes a near-miss field name", () => {
    // A card can render input the model PROPOSED, which reaches the approval
    // gate before the tool schema validates it. A blank target on an approval
    // prompt is worse than a tolerated alias.
    expect(classifyFleetTool(fleet("fleet_send", { name: "x" }))!.summary).toBe("Send to x");
    expect(classifyFleetTool(fleet("fleet_interrupt", { target: "y" }))!.summary).toBe(
      "Interrupt y",
    );
  });

  it("counts panel sessions and pluralises honestly", () => {
    const one = classifyFleetTool(fleet("fleet_panel", { sessions: ["a"] }))!;
    expect(one.summary).toBe("Panel — 1 session");
    const many = classifyFleetTool(
      fleet("fleet_panel", { sessions: ["a", "b"], shape: "ship", message: "review this" }),
    )!;
    expect(many.summary).toBe("Panel — 2 sessions");
    expect(valueOf(many, "sessions")).toBe("a, b");
    expect(valueOf(many, "shape")).toBe("ship");
    expect(valueOf(many, "message")).toBe("review this");
  });

  it("labels the remaining read verbs without inventing structure", () => {
    expect(classifyFleetTool(fleet("machine_map"))!.kind).toBe("observe");
    expect(classifyFleetTool(fleet("fleet_tasks", { limit: 5 }))!.summary).toBe(
      "Checking the task board",
    );
    // `limit` is not a field we claim to render; it is simply omitted.
    expect(classifyFleetTool(fleet("fleet_tasks", { limit: 5 }))!.fields).toEqual([]);
  });

  it("reads the input off the STATE while awaiting approval", () => {
    // The approval prompt is the card that most has to be readable, and at
    // waiting_confirmation the complete input lives on state, not tool.input.
    const awaiting = {
      toolId: "t1",
      name: "mcp__codeoid_fleet__fleet_spawn",
      state: {
        phase: "waiting_confirmation",
        input: { shape: "ship", workdir: "/repo/api", task: "bump the dep" },
      },
    } as unknown as ToolInfo;
    const card = classifyFleetTool(awaiting)!;
    expect(card.summary).toBe("Spawn ship in api");
    expect(valueOf(card, "task")).toBe("bump the dep");
  });

  it("ignores a half-generated streaming input", () => {
    // partialInput is a fragment; a card built from it would show a workdir the
    // model has not finished writing.
    const streaming = {
      toolId: "t1",
      name: "mcp__codeoid_fleet__fleet_spawn",
      state: { phase: "streaming", partialInput: { workdir: "/repo/ap" } },
    } as unknown as ToolInfo;
    const card = classifyFleetTool(streaming)!;
    expect(card.summary).toBe("Spawn worker");
    expect(card.fields).toEqual([]);
  });

  describe("hostile and malformed input", () => {
    it("never reports an unrecognised verb as a safe read", () => {
      // The read/send split is enforced daemon-side; this module duplicates the
      // vocabulary and can drift. A future send-class verb must not render as
      // an innocuous observe card just because this list is stale.
      const card = classifyFleetTool(fleet("fleet_detonate", { yes: true }))!;
      expect(card.kind).toBe("unknown");
      expect(card.sendClass).toBe(false);
      expect(card.fields).toEqual([]);
      expect(card.summary).toContain("unrecognised");
    });

    it("survives input that is missing, null, or the wrong type", () => {
      for (const bad of [undefined, null, "a string", 42, ["an", "array"]]) {
        const card = classifyFleetTool(fleet("fleet_spawn", bad))!;
        expect(card.kind).toBe("dispatch");
        expect(card.summary).toBe("Spawn worker");
        expect(card.fields).toEqual([]);
      }
    });

    it("ignores wrong-typed fields instead of rendering them", () => {
      const card = classifyFleetTool(
        fleet("fleet_spawn", { shape: "explode", workdir: 42, task: { nested: true } }),
      )!;
      expect(card.summary).toBe("Spawn worker"); // invalid shape → no claim
      expect(card.fields).toEqual([]);
    });

    it("treats a whitespace-only string as absent", () => {
      const card = classifyFleetTool(fleet("fleet_find", { query: "   " }))!;
      expect(card.summary).toBe("Resolving a session reference");
      expect(card.fields).toEqual([]);
    });

    it("drops non-string entries from a sessions array rather than the whole array", () => {
      const card = classifyFleetTool(fleet("fleet_panel", { sessions: ["a", 7, null, "b"] }))!;
      expect(valueOf(card, "sessions")).toBe("a, b");
    });

    it("keeps a workdir that is only separators legible in the header", () => {
      expect(classifyFleetTool(fleet("fleet_spawn", { workdir: "/" }))!.summary).toBe(
        "Spawn worker in /",
      );
      expect(classifyFleetTool(fleet("fleet_spawn", { workdir: "/a/b/" }))!.summary).toBe(
        "Spawn worker in b",
      );
    });
  });
});
