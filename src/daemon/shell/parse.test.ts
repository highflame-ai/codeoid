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
    expect(await argvs("xargs -n1 -I{} rm {}")).toEqual([["rm", null]]);
    expect(await argvs("find . -exec rm -f {} +")).toEqual([["find", ".", "-exec", "rm", "-f", "{}", "+"], ["rm", "-f", null]]);
  });

  it("reads wrappers' own options only, and sees through more of them (round-1 audit)", async () => {
    expect(await argvs("xargs -l rm -rf")).toEqual([["rm", "-rf", null]]);
    expect(await argvs("xargs -i rm -rf {}")).toEqual([["rm", "-rf", null]]);
    expect(await argvs("xargs -I% sh -c 'rm ~/%'")).toEqual([["sh", "-c", null]]);
    expect(await argvs("env - rm x")).toEqual([["rm", "x"]]);
    expect(await argvs("command rm -r -v x")).toEqual([["rm", "-r", "-v", "x"]]);
    expect(await argvs("busybox rm -rf x")).toEqual([["rm", "-rf", "x"]]);
    expect(await argvs("coproc rm x")).toEqual([["rm", "x"]]);
    expect(await argvs("trap 'rm x' EXIT")).toEqual([["trap", "rm x", "EXIT"], ["rm", "x"]]);
    expect(await argvs("script -qc 'rm x' /dev/null")).toEqual([["script", "-qc", "rm x", "/dev/null"], ["rm", "x"]]);
    expect(await argvs("find . -exec rm -rf {}/ \\;")).toEqual([["find", ".", "-exec", "rm", "-rf", "{}/", ";"], ["rm", "-rf", null]]);
    for (const c of ["env -iS'rm x'", "env -C /etc cat passwd", "strace -f rm x", "parallel rm ::: x", "unshare -r rm x", "/bin/r? x", "r{m,} x"]) {
      expect((await parseShell(c)).problems.length).toBeGreaterThan(0);
    }
  });

  it("records every variable the line sets, and whether a program's environment gets it (round-1 audit)", async () => {
    const { assignments } = await parseShell("A=1 x; B=2; export C=3 D; declare -x E=4; local F=5; env G=6 y; a[$(z)]=7");
    expect(assignments.map((a) => [a.name, a.value.value, a.exported])).toEqual([
      ["A", "1", true],
      ["B", "2", false],
      ["C", "3", true],
      ["E", "4", true],
      ["F", "5", false],
      ["G", "6", true],
      ["a", "7", false],
    ]);
    expect(await argvs("a[$(z)]=7")).toEqual([["z"]]);
  });

  it("records arithmetic on a variable, and doesn't understand a prompt expansion (round-1 audit)", async () => {
    for (const c of ["echo $((x))", "echo $[x]", "((x++))", "[[ $x -eq 0 ]]", "let y=x", "echo ${a[$i]}", "a[$i]=1", "echo ${x:0:len}", "for ((i=0; i<3; i++)); do :; done", "echo ${!x}"]) {
      const p = await parseShell(c);
      expect(p.arithmetic.length).toBeGreaterThan(0);
      expect(p.problems).toEqual([]);
    }
    for (const c of ["echo $((1+2))", "[[ $x == y ]]", "[ $x -eq 0 ]", "echo ${a[0]} ${x:0:3} ${x: -2} ${x@Q} ${#x}"]) {
      const p = await parseShell(c);
      expect(p.arithmetic).toEqual([]);
      expect(p.problems).toEqual([]);
    }
    expect((await parseShell("echo ${x@P}")).problems.length).toBeGreaterThan(0);
  });

  it("doesn't understand a variable name whose subscript holds code as text (round-2 audit)", async () => {
    for (const c of ["printf -v 'a[$(rm x)]' y", "test -v 'a[$(rm x)]'", "[ -v 'a[`rm x`]' ]", "[[ -v 'a[$(rm x)]' ]]", "declare 'a[$(rm x)]=1'", "unset 'a[$(rm x)]'", "read 'a[$(rm x)]'", "mapfile -C 'rm x' a"]) {
      expect((await parseShell(c)).problems.length).toBeGreaterThan(0);
    }
    // A run-time subscript is arithmetic on a variable.
    expect((await parseShell('printf -v "a[$i]" y')).arithmetic.length).toBeGreaterThan(0);
  });

  it("records the variables printf -v, read and mapfile set (round-2 audit)", async () => {
    const names = async (c: string) => (await parseShell(c)).assignments.map((a) => a.name);
    expect(await names("printf -v X '%s' y")).toEqual(["X"]);
    expect(await names("printf -vX y")).toEqual(["X"]);
    expect(await names("read -r -p 'go? ' A B <<< x")).toEqual(["A", "B"]);
    expect(await names("read -ra ARR <<< x")).toEqual(["ARR"]);
    expect(await names("mapfile -t lines < f")).toEqual(["lines"]);
  });

  it("lists the constructs beyond plain commands and lists (round-2 redesign)", async () => {
    const constructs = async (c: string) => (await parseShell(c)).constructs;
    const first = async (c: string) => (await constructs(c))[0];
    for (const c of ["ls; pwd", "a && b || c", "(cd x; ls)", "{ ls; }", "if true; then ls; elif false; then pwd; else id; fi", "! ls", "x=1", "ls | wc -l # count"]) {
      expect(await constructs(c)).toEqual([]);
    }
    // The outermost first: a loop's words and body follow it.
    expect(await first("for f in a; do ls; done")).toBe("a for loop");
    expect(await first("while true; do ls; done")).toBe("a while loop");
    expect(await first("[[ -f a ]] && ls")).toBe("[[ … ]]");
    expect(await first("((n++))")).toBe("(( … ))");
    expect(await first("declare -x A=1")).toBe("declare");
    expect(await first("f() { ls; }")).toBe("a function definition");
  });

  it("reads time and coproc in front of a compound command as not understood, with what's inside listed (round-2 audit)", async () => {
    for (const c of ["time { rm -rf x; }", "time while true; do rm x; done", "coproc X { rm x; }", "coproc { rm x; }"]) {
      const p = await parseShell(c);
      expect(p.problems.length).toBeGreaterThan(0);
      expect(p.commands.some((k) => k.argv[0]?.value === "rm")).toBe(true);
    }
    expect((await parseShell("time ls")).problems).toEqual([]);
    expect((await parseShell("coproc ls")).problems).toEqual([]);
  });

  it("reads a shell's /dev/stdin script as its input (round-2 audit)", async () => {
    expect(await argvs("echo 'rm x' | bash /dev/stdin")).toEqual([["echo", "rm x"], ["bash", "/dev/stdin"]]);
    expect((await parseShell("echo 'rm x' | bash /dev/stdin")).commands[1]!.stdinScript).toBe(true);
    expect((await parseShell("echo 'rm x' | bash < /dev/stdin")).commands[1]!.stdinScript).toBe(true);
    expect(await argvs("bash /dev/fd/0 <<< 'rm x'")).toEqual([["bash", "/dev/fd/0"], ["rm", "x"]]);
  });

  it("keeps the words a wrapper takes for itself (round-2 audit)", async () => {
    const { commands } = await parseShell("xargs -a list.txt echo");
    expect(commands[0]!.argv.map((w) => w.value)).toEqual(["echo", null]);
    expect(commands[0]!.wrapped?.map((w) => w.value)).toEqual(["-a", "list.txt"]);
    expect((await parseShell("time -o out.txt ls")).commands[0]!.wrapped?.map((w) => w.value)).toEqual(["-o", "out.txt"]);
  });

  it("finds what fd -x / -X runs on each match", async () => {
    expect(await argvs("fd -e ts -x wc -l")).toEqual([["fd", "-e", "ts", "-x", "wc", "-l"], ["wc", "-l", null]]);
    expect(await argvs("fd . -X rm {} \\;")).toEqual([["fd", ".", "-X", "rm", "{}", ";"], ["rm", null]]);
  });

  it("records pipeline stages and what substitutions feed", async () => {
    const { commands } = await parseShell("curl x | sh; bash <(wget y)");
    const by = (n: string) => commands.find((c) => c.argv[0]?.value === n)!;
    expect(by("curl").pipeline).toBe(by("sh").pipeline);
    expect([by("curl").stage, by("sh").stage]).toEqual([0, 1]);
    expect(by("wget").substitution).toBe("process-in");
    expect(commands[by("wget").feeds!]!.argv[0]!.value).toBe("bash");
  });

  it("marks a shell that runs its input, and what a statement's redirect substitution feeds (round-1 audit)", async () => {
    const stdin = async (c: string) => (await parseShell(c)).commands.filter((x) => x.stdinScript).map((x) => x.argv[0]!.value);
    expect(await stdin("x | sh")).toEqual(["sh"]);
    expect(await stdin("x | bash -s -- a")).toEqual(["bash"]);
    expect(await stdin("bash < <(x)")).toEqual(["bash"]);
    expect(await stdin("source <(x)")).toEqual(["source"]);
    expect(await stdin("x | bash run.sh")).toEqual([]);
    expect(await stdin("bash < run.sh")).toEqual([]);
    const { commands } = await parseShell("bash < <(curl x)");
    expect(commands[commands.find((c) => c.argv[0]?.value === "curl")!.feeds!]!.argv[0]!.value).toBe("bash");
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
