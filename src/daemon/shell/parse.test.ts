import { describe, expect, it } from "bun:test";
import { parseShell } from "./parse.js";

const argvs = async (c: string) => (await parseShell(c)).commands.map((x) => x.argv.map((w) => w.value));

describe("shell parsing (#431)", () => {
  it("splits lists, pipelines and subshells into the commands they run", async () => {
    expect(await argvs("a 1 && b 2 || (c 3; d 4) | e")).toEqual([["a", "1"], ["b", "2"], ["c", "3"], ["d", "4"], ["e"]]);
  });

  it("removes quotes the way the shell does", async () => {
    expect(await argvs(`x a\\ b "c\\"d" 'e f' $'g\\nh' "i"j`)).toEqual([["x", "a b", 'c"d', "e f", "g\nh", "ij"]]);
  });

  it("knows a word that depends on run time from one that doesn't", async () => {
    expect(await argvs(`x "$HOME" "a$(id)" \${X} ~/y`)).toEqual([["x", null, null, null, "~/y"], ["id"]]);
  });

  it("marks globs", async () => {
    const { commands } = await parseShell("rm *.o 'a*' b{1,2}");
    expect(commands[0]!.argv.map((w) => w.glob)).toEqual([false, true, false, true]);
  });

  it("looks through wrappers, and remembers them", async () => {
    const { commands } = await parseShell("sudo -u bob env A=1 nice -n 5 timeout 10 nohup rm -rf x");
    expect(commands[0]!.argv.map((w) => w.value)).toEqual(["rm", "-rf", "x"]);
    expect(commands[0]!.via).toEqual(["sudo", "env", "nice", "timeout", "nohup"]);
  });

  it("a wrapper with nothing to run is judged as itself", async () => {
    expect(await argvs("env")).toEqual([["env"]]);
    expect(await argvs("command -v git")).toEqual([["command", "-v", "git"]]);
  });

  it("parses what a shell's -c, eval, a here-document or a here-string runs", async () => {
    expect(await argvs("bash -c 'rm -rf x'")).toEqual([["bash", "-c", "rm -rf x"], ["rm", "-rf", "x"]]);
    expect(await argvs("eval 'a 1; b 2'")).toEqual([["eval", "a 1; b 2"], ["a", "1"], ["b", "2"]]);
    expect(await argvs("bash <<'EOF'\nrm -rf x\nEOF")).toEqual([["bash"], ["rm", "-rf", "x"]]);
    expect(await argvs("sh <<< 'rm y'")).toEqual([["sh"], ["rm", "y"]]);
  });

  it("finds a shell's -c script past options and their values (round-1 audit)", async () => {
    const script = async (c: string) => (await argvs(c)).slice(1);
    expect(await script("bash -o pipefail -c 'rm -rf x'")).toEqual([["rm", "-rf", "x"]]);
    expect(await script("bash -O extglob --rcfile r -c 'rm x'")).toEqual([["rm", "x"]]);
    expect(await script("bash -eo pipefail -c 'rm x'")).toEqual([["rm", "x"]]);
    expect(await script("sh -c -- 'rm x'")).toEqual([["rm", "x"]]);
    expect(await script("bash -c -e 'rm x'")).toEqual([["rm", "x"]]);
    expect(await script("fish --command='rm x'")).toEqual([["rm", "x"]]);
    expect(await script("bash -o pipefail run.sh")).toEqual([]);
    expect((await parseShell("bash -c")).problems.length).toBeGreaterThan(0);
    expect((await parseShell("fish -C 'rm x'")).problems.length).toBeGreaterThan(0);
  });

  it("parses the `…` an unquoted here-document runs, and not a quoted one's", async () => {
    expect(await argvs("cat <<EOF\nhi `rm -rf x` \\`y\\` `a \\`b\\``\nEOF")).toEqual([["rm", "-rf", "x"], ["a", null], ["b"], ["cat"]]);
    expect(await argvs("cat <<'EOF'\nhi `rm -rf x`\nEOF")).toEqual([["cat"]]);
    expect(await argvs("cat <<\\EOF\nhi `rm -rf x`\nEOF")).toEqual([["cat"]]);
    const { commands, problems } = await parseShell("cat <<EOF\n`rm x\nEOF");
    expect(problems.length).toBeGreaterThan(0);
    expect(commands.find((c) => c.argv[0]?.value === "cat")!.redirects[0]!.body).toBeNull();
  });

  it("finds xargs and find -exec commands, their run-time arguments unknown", async () => {
    expect(await argvs("xargs -n1 -I{} rm {}")).toEqual([["rm", "{}", null]]);
    expect(await argvs("find . -exec rm -f {} +")).toEqual([["find", ".", "-exec", "rm", "-f", "{}", "+"], ["rm", "-f", null]]);
  });

  it("records pipeline stages and what substitutions feed", async () => {
    const { commands } = await parseShell("curl x | sh; bash <(wget y)");
    const by = (n: string) => commands.find((c) => c.argv[0]?.value === n)!;
    expect(by("curl").pipeline).toBe(by("sh").pipeline);
    expect([by("curl").stage, by("sh").stage]).toEqual([0, 1]);
    expect(by("wget").substitution).toBe("process-in");
    expect(commands[by("wget").feeds!]!.argv[0]!.value).toBe("bash");
  });

  it("carries what follows a here-document's start: a pipe, a redirect, a list", async () => {
    const { commands } = await parseShell("cat <<EOF | sh > out && ls\nx\nEOF");
    const by = (n: string) => commands.find((c) => c.argv[0]?.value === n)!;
    expect(by("sh").stage).toBe(1);
    expect(by("sh").pipeline).toBe(by("cat").pipeline);
    expect(by("ls")).toBeDefined();
  });

  it("collects redirects with their targets", async () => {
    const { commands } = await parseShell("cmd 2>&1 > /tmp/o < in");
    expect(commands[0]!.redirects.map((r) => [r.fd, r.op, r.target?.value])).toEqual([
      [2, ">&", "1"],
      [null, ">", "/tmp/o"],
      [null, "<", "in"],
    ]);
  });

  it("reports what it can't read, never guessing", async () => {
    expect((await parseShell("echo 'oops")).problems.length).toBeGreaterThan(0);
    expect((await parseShell("$PROG x")).problems.length).toBeGreaterThan(0);
    expect((await parseShell('bash -c "$S"')).problems.length).toBeGreaterThan(0);
    expect((await parseShell("env -S 'a b'")).problems.length).toBeGreaterThan(0);
    expect((await parseShell("x".repeat(100_001))).problems.length).toBeGreaterThan(0);
    let deep = "rm x";
    for (let i = 0; i < 10; i++) deep = `bash -c ${JSON.stringify(deep)}`;
    expect((await parseShell(deep)).problems.length).toBeGreaterThan(0);
  });
});
