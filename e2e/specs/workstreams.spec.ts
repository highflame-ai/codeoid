import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../harness";

// Workstreams W0 (docs/workstreams-design.md): a session's home is decided at
// create by its folder (or an explicit choice), shown, refused past an
// exclusive claim, and kept across a restart.
test("a session's workstream comes from its folder, an exclusive folder refuses another, and the home survives a restart", async ({ codeoid }) => {
  const scratch = join(codeoid.root, "scratch");
  mkdirSync(scratch, { recursive: true });
  codeoid.configure({
    workstreams: {
      items: [
        { id: "acme", name: "Acme Corp", claim: "exclusive", match: { paths: [codeoid.workdir] } },
        { id: "research", match: { paths: ["~/never"] } },
      ],
      default: "research",
    },
  });
  await codeoid.restart();

  const ls = await codeoid.cliOk("workstream", "ls");
  expect(ls).toContain("acme");
  expect(ls).toContain("exclusive");
  expect(ls).toMatch(/research.*default/);

  const match = await codeoid.cliOk("workstream", "match", codeoid.workdir);
  expect(match).toContain(`Workstream: acme — matched by ${codeoid.workdir}`);

  const conflict = await codeoid.cliOk("workstream", "match", codeoid.workdir, "--workstream", "research");
  expect(conflict).toContain('belongs to "acme" (exclusive)');

  expect(await codeoid.cliOk("new", "in-acme", codeoid.workdir)).toContain("workstream: Acme Corp (acme) — matched by");
  expect(await codeoid.cliOk("new", "loose", scratch)).toContain("workstream: research — the default");

  const refused = await codeoid.cli("new", "wrong-home", codeoid.workdir, "--workstream", "research");
  expect(refused.code).not.toBe(0);
  expect(refused.output).toContain('This folder belongs to workstream "acme"');

  await codeoid.restart();
  const after = await codeoid.cliOk("ls");
  expect(after).toContain("workstream: Acme Corp (acme) — matched by");
  expect(after).toContain("workstream: research — the default");
  expect(after).not.toContain("wrong-home");
});
