/**
 * The git gateway's reading of a fetch (upload-filter.ts): only protocol v0's own lines reach upload-pack, and none
 * names an object the remote's refs don't reach.
 */
import { describe, expect, test } from "bun:test";
import { UploadFilter } from "../daemon/git-gateway/upload-filter.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const GONE = "d".repeat(40);
const pkt = (s: string) => `${(Buffer.byteLength(s) + 4).toString(16).padStart(4, "0")}${s}`;

async function run(input: string): Promise<{ out: string; failed: boolean }> {
  let out = "";
  let failed = false;
  let stop = () => {};
  const ended = new Promise<void>((r) => {
    stop = r;
  });
  const f = new UploadFilter(
    async (ids) => new Set(ids.filter((i) => i !== GONE)),
    async () => new Set(["refs/heads/main", "refs/tags/v1"]),
    (b) => {
      out += b.toString("latin1");
    },
    () => {
      failed = true;
      stop();
    },
  );
  // In pieces, as a socket brings it.
  const bytes = Buffer.from(input, "latin1");
  for (let i = 0; i < bytes.length; i += 7) f.push(bytes.subarray(i, i + 7));
  f.end(stop);
  await ended;
  await new Promise((r) => setTimeout(r, 10));
  return { out, failed };
}

describe("the gateway's reading of a fetch", () => {
  test("an ordinary fetch passes as it is", async () => {
    const req = `${pkt(`want ${A} multi_ack_detailed side-band-64k thin-pack ofs-delta\n`)}${pkt(`want ${B}\n`)}0000${pkt(`have ${A}\n`)}0000${pkt("done\n")}`;
    expect(await run(req)).toEqual({ out: req, failed: false });
  });

  test("a shallow or have line naming what no ref reaches is dropped; the rest goes", async () => {
    const r = await run(`${pkt(`want ${A}\n`)}${pkt(`shallow ${GONE}\n`)}${pkt(`shallow ${B}\n`)}${pkt("deepen 1\n")}0000${pkt(`have ${GONE}\n`)}${pkt(`have ${B}\n`)}${pkt("done\n")}`);
    expect(r.failed).toBe(false);
    expect(r.out).not.toContain(GONE);
    expect(r.out).toBe(`${pkt(`want ${A}\n`)}${pkt(`shallow ${B}\n`)}${pkt("deepen 1\n")}0000${pkt(`have ${B}\n`)}${pkt("done\n")}`);
  });

  test("a filter that names an object, a deepen-not that isn't an advertised ref, anything else: the request ends", async () => {
    for (const bad of [
      `filter sparse:oid=${GONE}\n`,
      "filter combine:blob:none+tree:0\n",
      `deepen-not ${GONE}\n`,
      "deepen-not refs/heads/secret\n",
      "want-ref refs/heads/main\n",
      `want ${A}\u0000agent=x\n`,
      "command=fetch\n",
    ]) {
      expect((await run(`${pkt(`want ${A}\n`)}${pkt(bad)}0000`)).failed, bad).toBe(true);
    }
    // Round 19: a short name is resolved as git does (a tag first) and passed on by its full name; no filter at all.
    const short = await run(`${pkt(`want ${A}\n`)}${pkt("deepen-not main\n")}${pkt("deepen-not v1\n")}0000${pkt("done\n")}`);
    expect(short).toEqual({ out: `${pkt(`want ${A}\n`)}${pkt("deepen-not refs/heads/main\n")}${pkt("deepen-not refs/tags/v1\n")}0000${pkt("done\n")}`, failed: false });
    for (const bad of ["deepen-not codeoid-check/x/heads/main\n", "deepen-not refs/codeoid-check/x/heads/main\n", "filter blob:none\n"]) {
      expect((await run(`${pkt(`want ${A}\n`)}${pkt(bad)}0000`)).failed, bad).toBe(true);
    }
    // Bounded: a request that never flushes can't grow without end.
    expect((await run(`${pkt(`want ${A}\n`)}0000${pkt(`have ${A}\n`).repeat(100_001)}`)).failed).toBe(true);
    // A delim packet (v2's), a bad length, a line after done.
    expect((await run(`${pkt(`want ${A}\n`)}0001`)).failed).toBe(true);
    expect((await run("zzzz")).failed).toBe(true);
    expect((await run(`${pkt(`want ${A}\n`)}0000${pkt("done\n")}${pkt(`have ${A}\n`)}`)).failed).toBe(true);
  });
});
