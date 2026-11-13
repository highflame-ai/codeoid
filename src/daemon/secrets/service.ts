/**
 * The daemon's secret handling (docs/secrets-and-memory-design.md §2), one
 * per daemon: the values codeoid knows, the fingerprint key, the vault, and
 * the scrubber every store goes through.
 *
 * `scrub(text, ctx)` is what callers use; `verdict(...)` decides what of a
 * tool call is stored at all. With `secrets.enabled: false` both are
 * pass-throughs (for debugging only).
 */

import type { SecretsConfig } from "../../config.js";
import type { AccountStore } from "../accounts.js";
import type { CredentialDecl } from "../credentials/schema.js";
import type { SecretStore } from "../credentials/store.js";
import type { EndpointStore } from "../openai-endpoints.js";
import type { Store } from "../store.js";
import { Fingerprinter, loadOrCreateKey, secretMaterialDir } from "./fingerprint.js";
import { type KnownSecret, KnownSecrets, LearnedSecrets } from "./known.js";
import { type ScrubContext, type ScrubResult, Scrubber } from "./scrub.js";
import { type ToolVerdict, toolVerdict } from "./verdict.js";
import { CapturedSecretVault } from "./vault.js";

export interface SecretServiceOptions {
  config?: SecretsConfig;
  configDir: string;
  store?: Store;
  /** Whether a workstream keeps detected secrets ('' = sessions with no workstream). */
  capturePolicy?: (workstream: string | undefined) => "drop" | "vault";
}

/** Scrub context with the owner, so a kept secret lands in the right tenant. */
export interface StoreScrubContext extends ScrubContext {
  accountId?: string;
  projectId?: string;
}

export const DEFAULT_SECRETS_CONFIG: SecretsConfig = { enabled: true, beforeModel: true, captureSecrets: "drop", vaultDays: 30, dropCommands: [], credentialFiles: [] };

export class SecretService {
  readonly known = new KnownSecrets();
  /** Values found by shape this run, matched exactly from then on (memory only). */
  readonly learned = new LearnedSecrets();
  readonly config: SecretsConfig;
  readonly vault: CapturedSecretVault | undefined;
  readonly #scrubber: Scrubber;
  #capturePolicy: (workstream: string | undefined) => "drop" | "vault";

  constructor(opts: SecretServiceOptions) {
    this.config = opts.config ?? DEFAULT_SECRETS_CONFIG;
    const dir = secretMaterialDir(opts.configDir);
    const fingerprint = new Fingerprinter(loadOrCreateKey(dir, "fingerprint.key"));
    this.vault = opts.store ? new CapturedSecretVault(opts.store, loadOrCreateKey(dir, "vault.key")) : undefined;
    this.#capturePolicy = opts.capturePolicy ?? (() => this.config.captureSecrets);
    this.known.register("learned", () => this.learned.values());
    this.learned.onChange(() => this.known.invalidate());
    this.#scrubber = new Scrubber({
      known: this.known,
      learned: this.learned,
      fingerprint,
      onDetected: (secret, ctx) => {
        const c = ctx as StoreScrubContext;
        if (!this.vault || !c.accountId || !c.projectId) return;
        if (this.#capturePolicy(c.workstream) !== "vault") return;
        this.vault.put({ accountId: c.accountId, projectId: c.projectId, workstream: c.workstream ?? "" }, { ...secret, ...(c.sessionId ? { sessionId: c.sessionId } : {}) });
      },
    });
  }

  /** Who decides whether a workstream keeps detected secrets (the session manager, which knows the workstreams). */
  setCapturePolicy(policy: (workstream: string | undefined) => "drop" | "vault"): void {
    this.#capturePolicy = policy;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get scrubber(): Scrubber {
    return this.#scrubber;
  }

  /** Add a source of values codeoid knows; returns a function that removes it. */
  addKnown(name: string, source: () => Iterable<KnownSecret>): () => void {
    return this.known.register(name, source);
  }

  scrub(text: string, ctx: StoreScrubContext = {}): ScrubResult {
    if (!this.config.enabled) return { text, changed: false };
    return this.#scrubber.scrub(text, ctx);
  }

  scrubValue<T>(value: T, ctx: StoreScrubContext = {}): { value: T; changed: boolean } {
    if (!this.config.enabled) return { value, changed: false };
    return this.#scrubber.scrubValue(value, ctx);
  }

  verdict(toolName: string, input: unknown, cwd: string): ToolVerdict {
    if (!this.config.enabled) return "keep";
    return toolVerdict(toolName, input, { cwd, dropCommands: this.config.dropCommands, credentialFiles: this.config.credentialFiles });
  }

  /** Forget kept secrets past `vaultDays`. */
  expireVault(): number {
    return this.vault?.expire(this.config.vaultDays) ?? 0;
  }
}

/**
 * The daemon's own keys in its environment: `CODEOID_*` values (credentials
 * from the env-file store among them) and anything whose name says it is a
 * secret (`*_API_KEY`, `*_TOKEN`, …).
 */
export function environmentSecrets(env: Record<string, string | undefined> = process.env): KnownSecret[] {
  const out: KnownSecret[] = [];
  const NAME = /(?:^CODEOID_CRED_|_API_KEY$|_TOKEN$|_SECRET$|_PASSWORD$|_ACCESS_KEY$|^ANTHROPIC_AUTH_TOKEN$|_KEY$)/;
  for (const [name, value] of Object.entries(env)) {
    if (!value || !NAME.test(name)) continue;
    out.push({ label: name.startsWith("CODEOID_CRED_") ? name.slice("CODEOID_CRED_".length).toLowerCase().replace(/_/g, "-") : `daemon:${name}`, value });
  }
  return out;
}

/**
 * Every place codeoid holds a credential value (§2.2): declared credentials
 * in the secret store, the daemon's environment, every backend's accounts,
 * OpenAI-compatible endpoints, and the database's OAuth tokens and conductor
 * key. The daemon and `codeoid secret scrub` register the same sources.
 */
export function addDaemonKnownSources(
  secrets: SecretService,
  deps: { credentials: () => readonly CredentialDecl[]; secretStore: SecretStore; accounts: AccountStore; endpoints: EndpointStore; store: Store },
): void {
  secrets.addKnown("credentials", () =>
    deps.credentials().flatMap((c) => {
      if (c.kind === "oauth") return [];
      const value = deps.secretStore.get(c.id);
      return value ? [{ label: c.id, value }] : [];
    }),
  );
  secrets.addKnown("environment", () => environmentSecrets(process.env));
  secrets.addKnown("accounts", () =>
    deps.accounts.backendsWithData().flatMap((backend) =>
      deps.accounts.list(backend).flatMap((info) => {
        const a = deps.accounts.get(backend, info.name);
        if (!a) return [];
        const label = `account:${backend}:${a.name}`;
        return [a.token, ...Object.values(a.headers ?? {}), ...Object.values(a.env ?? {})].filter((v): v is string => typeof v === "string").map((value) => ({ label, value }));
      }),
    ),
  );
  secrets.addKnown("endpoints", () =>
    deps.endpoints.entries().flatMap((e) =>
      [e.apiKey, ...Object.values(e.headers ?? {})].filter((v): v is string => typeof v === "string").map((value) => ({ label: `endpoint:${e.name}`, value })),
    ),
  );
  secrets.addKnown("store", () => deps.store.knownSecretValues());
  deps.accounts.onChange(() => secrets.known.invalidate());
  deps.endpoints.onChange(() => secrets.known.invalidate());
}
