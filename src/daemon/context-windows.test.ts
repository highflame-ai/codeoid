import { describe, test, expect } from "bun:test";
import {
  DEFAULT_CONTEXT_WINDOW,
  ONE_MILLION_CONTEXT,
  contextWindowForModel,
} from "./context-windows";

describe("contextWindowForModel", () => {
  test("current 1M families -> 1M", () => {
    expect(contextWindowForModel("claude-opus-4-8")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("claude-opus-4-7")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("claude-opus-4-6")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("claude-sonnet-5")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("claude-sonnet-4-6")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("claude-fable-5")).toBe(ONE_MILLION_CONTEXT);
  });

  test("dated point releases keep the family window", () => {
    expect(contextWindowForModel("claude-opus-4-8-20260101")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("claude-opus-4-7-20260101")).toBe(ONE_MILLION_CONTEXT);
  });

  test("opus / sonnet aliases -> 1M (Opus 4.8 / Sonnet 5)", () => {
    expect(contextWindowForModel("opus")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("sonnet")).toBe(ONE_MILLION_CONTEXT);
  });

  test("haiku alias and full id -> 200k", () => {
    expect(contextWindowForModel("haiku")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowForModel("claude-haiku-4-5")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowForModel("claude-haiku-4-5-20251001")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  test("explicit -1m suffix -> 1M", () => {
    expect(contextWindowForModel("claude-sonnet-4-5-1m")).toBe(ONE_MILLION_CONTEXT);
  });

  test("bracket [1m] form -> 1M (the form Claude Code actually emits)", () => {
    // Regression: these resolved to 200k, so asking EXPLICITLY for the 1M
    // variant sized the window WORSE than the bare `opus` alias — observed on
    // a live session running `opus[1m]`, which reported ~500% occupancy and a
    // 5x-too-small fork seed budget.
    expect(contextWindowForModel("opus[1m]")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("sonnet[1m]")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("claude-opus-5[1m]")).toBe(ONE_MILLION_CONTEXT);
    // Case-insensitive, like every other branch.
    expect(contextWindowForModel("OPUS[1M]")).toBe(ONE_MILLION_CONTEXT);
  });

  test("haiku stays 200k in bracket form too", () => {
    // haiku has no 1M variant; a bracket suffix must not manufacture one.
    expect(contextWindowForModel("haiku")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  test("unknown claude model -> conservative 200k miss", () => {
    expect(contextWindowForModel("claude-sonnet-4-0")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowForModel("custom-model")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  test("undefined / empty -> 1M (codeoid default == opus family)", () => {
    expect(contextWindowForModel(undefined)).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel(null)).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("")).toBe(ONE_MILLION_CONTEXT);
  });

  test("case-insensitive", () => {
    expect(contextWindowForModel("Claude-Opus-4-8")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("OPUS")).toBe(ONE_MILLION_CONTEXT);
  });
});
