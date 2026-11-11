import { mkdirSync, writeFileSync } from "node:fs";
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

// Workstreams W1: with isolation on, a user's session must have a home; an
// exclusive folder can be overridden only by confirming; credentials are
// declared by name and their values never shown.
test("under isolation a session needs a home, an exclusive folder takes a confirmed override, and credentials show by name only", async ({ codeoid }) => {
  const scratch = join(codeoid.root, "scratch");
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(codeoid.configDir, "codeoid", ".env"), "CODEOID_CRED_GH_ACME=ghp_e2e_secret\n");
  codeoid.configure({
    credentials: [{ id: "gh-acme", kind: "env" }],
    workstreams: {
      isolateGlobalServers: true,
      items: [
        { id: "acme", claim: "exclusive", match: { paths: [codeoid.workdir] }, env: { GH_TOKEN: { secret: "gh-acme" } }, git: { email: "bot@acme.example" } },
        { id: "research", match: { paths: ["~/never"] } },
      ],
    },
  });
  await codeoid.restart();

  const show = await codeoid.cliOk("workstream", "show", "acme");
  expect(show).toContain("GH_TOKEN");
  expect(show).not.toContain("ghp_e2e_secret");
  expect(await codeoid.cliOk("workstream", "ls")).toContain("Server isolation: on");

  const homeless = await codeoid.cli("new", "nowhere", scratch);
  expect(homeless.code).not.toBe(0);
  expect(homeless.output).toContain("belongs to no workstream: choose one (acme, research)");
  expect(await codeoid.cliOk("new", "chosen", scratch, "--workstream", "research")).toContain("workstream: research — chosen");

  // No terminal and no --override: refused, saying how to confirm.
  const asked = await codeoid.cli("new", "past-claim", codeoid.workdir, "--workstream", "research");
  expect(asked.code).not.toBe(0);
  expect(asked.output).toContain('belongs to workstream "acme" (exclusive)');
  expect(asked.output).toContain("pass --override");
  expect(await codeoid.cliOk("new", "past-claim", codeoid.workdir, "--workstream", "research", "--override")).toContain("chosen past the folder's own workstream");
  expect(await codeoid.cliOk("ls")).toContain("chosen past the folder's own workstream");
});
