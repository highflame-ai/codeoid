import { describe, expect, it } from "vitest";

import { EMPTY_FORM, fromForm, toForm } from "./workstream-form";

describe("workstream form", () => {
  it("round-trips a configured item, keeping fields the editor doesn't show", () => {
    const config = {
      id: "acme",
      name: "Acme",
      claim: "exclusive",
      allowOverride: false,
      share: "closed",
      abstract: false,
      extends: ["base"],
      match: { paths: ["~/acme/**"], remotes: ["github.com/acme/*"] },
      mcpServers: ["web", { server: "github", credential: "gh-acme" }],
      env: { GH_TOKEN: { secret: "gh-acme" } },
      git: { email: "bot@acme.example" },
      exclude: ["notes"],
      accounts: { claude: "work" },
    };
    const form = toForm(config);
    expect(form).toMatchObject({ claim: "exclusive", allowOverride: false, share: "closed", servers: "web\ngithub = gh-acme", env: "GH_TOKEN = gh-acme", gitEmail: "bot@acme.example" });
    expect(fromForm(form, config)).toEqual(config);
  });

  it("builds a new item from text: blank lines dropped, a base has no rules", () => {
    const item = fromForm({ ...EMPTY_FORM, id: " mine ", paths: "~/a\n\n ~/b \n", servers: "x = cred\n", abstract: false });
    expect(item).toMatchObject({ id: "mine", match: { paths: ["~/a", "~/b"], remotes: [] }, mcpServers: [{ server: "x", credential: "cred" }], env: {} });
    expect(item).not.toHaveProperty("git");
    expect(fromForm({ ...EMPTY_FORM, id: "b", abstract: true, paths: "~/x" })).toMatchObject({ abstract: true, match: { paths: [], remotes: [] } });
  });
});
