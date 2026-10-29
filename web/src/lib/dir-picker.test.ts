import { describe, expect, it } from "vitest";

import type { FsEntry } from "../protocol/types";
import { breadcrumbs, filterEntries, matchRange, parseQuery, sameDir, selfAndAncestors, tildify } from "./dir-picker";

const dir = (name: string): FsEntry => ({ name, path: `/x/${name}`, kind: "directory" });

describe("parseQuery", () => {
  it("treats plain text as a filter of the folder on screen", () => {
    expect(parseQuery("  src ")).toEqual({ dir: null, needle: "src" });
  });
  it("splits a path into the directory to browse and the segment to filter by", () => {
    expect(parseQuery("/")).toEqual({ dir: "/", needle: "" });
    expect(parseQuery("/usr/lo")).toEqual({ dir: "/usr/", needle: "lo" });
    expect(parseQuery("/usr/local/")).toEqual({ dir: "/usr/local/", needle: "" });
    expect(parseQuery("~")).toEqual({ dir: "~", needle: "" });
    expect(parseQuery("~/Work")).toEqual({ dir: "~/", needle: "Work" });
  });
  it("leaves ~name (another user's home) as a filter", () => {
    expect(parseQuery("~bob").dir).toBeNull();
  });
});

describe("filterEntries", () => {
  const entries = ["api", "codeoid", "Docs", "web-app"].map(dir);
  it("puts prefix matches before substring matches", () => {
    expect(filterEntries(entries, "a").map((e) => e.name)).toEqual(["api", "web-app"]);
    expect(filterEntries(entries, "o").map((e) => e.name)).toEqual(["codeoid", "Docs"]);
  });
  it("is smart-case", () => {
    expect(filterEntries(entries, "docs").map((e) => e.name)).toEqual(["Docs"]);
    expect(filterEntries(entries, "D").map((e) => e.name)).toEqual(["Docs"]);
  });
  it("matchRange locates the needle for highlighting", () => {
    expect(matchRange("web-app", "app")).toEqual([4, 7]);
    expect(matchRange("web", "z")).toBeNull();
  });
});

describe("breadcrumbs", () => {
  it("starts at ~ inside home and at the root elsewhere", () => {
    expect(breadcrumbs("/home/me/src/x", "/", "/home/me").map((c) => c.label)).toEqual(["~", "src", "x"]);
    expect(breadcrumbs("/Workspace/codeoid", "/", "/home/me")).toEqual([
      { label: "/", path: "/" },
      { label: "Workspace", path: "/Workspace" },
      { label: "codeoid", path: "/Workspace/codeoid" },
    ]);
    expect(breadcrumbs("/srv/a", "/srv", null).map((c) => c.path)).toEqual(["/srv", "/srv/a"]);
  });
});

describe("path helpers", () => {
  it("tildify", () => {
    expect(tildify("/home/me/a", "/home/me")).toBe("~/a");
    expect(tildify("/home/meow", "/home/me")).toBe("/home/meow");
  });
  it("sameDir ignores a trailing slash", () => {
    expect(sameDir("/a/", "/a")).toBe(true);
    expect(sameDir("/", "/")).toBe(true);
  });
  it("selfAndAncestors walks up to the top", () => {
    expect(selfAndAncestors("/a/b/")).toEqual(["/a/b", "/a", "/"]);
    expect(selfAndAncestors("~/a")).toEqual(["~/a", "~"]);
  });
});
