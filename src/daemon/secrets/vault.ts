/**
 * Detected secrets a workstream keeps (docs/secrets-and-memory-design.md
 * §2.5): opt-in, `captureSecrets: "vault"`, so a person can still get one
 * back later. Values are sealed with AES-256-GCM under `vault.key` (beside
 * the fingerprint key, outside the database), so a copy of the database
 * alone holds none. Read back only by the owner (`reveal`), audited by the
 * caller; expired after `secrets.vaultDays` unless promoted to a credential.
 *
 * A kept secret belongs to one workstream: it is never revealed from
 * another, so a closed workstream's secrets stay its own.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Store } from "../store.js";

export interface VaultScope {
  accountId: string;
  projectId: string;
  /** '' for sessions with no workstream. */
  workstream: string;
}

export class CapturedSecretVault {
  readonly #store: Store;
  readonly #key: Buffer;

  constructor(store: Store, key: Buffer) {
    this.#store = store;
    this.#key = key;
  }

  put(scope: VaultScope, secret: { kind: string; fingerprint: string; value: string; sessionId?: string }): void {
    this.#store.putCapturedSecret({
      ...scope,
      fingerprint: secret.fingerprint,
      kind: secret.kind,
      sealed: this.#seal(secret.value, scope, secret.fingerprint),
      ...(secret.sessionId ? { sessionId: secret.sessionId } : {}),
      at: Date.now(),
    });
  }

  list(scope: { accountId: string; projectId: string; workstream?: string }) {
    return this.#store.listCapturedSecrets(scope);
  }

  /** The value, or undefined when this workstream keeps no such secret (or it can't be opened). */
  reveal(scope: VaultScope, fingerprint: string): string | undefined {
    const row = this.#store.capturedSecret({ ...scope, fingerprint });
    if (!row) return undefined;
    try {
      return this.#open(row.sealed, scope, fingerprint);
    } catch {
      return undefined;
    }
  }

  forget(scope: VaultScope, fingerprint: string): boolean {
    return this.#store.deleteCapturedSecret({ ...scope, fingerprint });
  }

  expire(days: number): number {
    return this.#store.expireCapturedSecrets(Date.now() - days * 86_400_000);
  }

  /** Bound to where it is kept: a sealed value moved to another row doesn't open. */
  #aad(scope: VaultScope, fingerprint: string): Buffer {
    return Buffer.from(`${scope.accountId}\u0000${scope.projectId}\u0000${scope.workstream}\u0000${fingerprint}`);
  }

  #seal(value: string, scope: VaultScope, fingerprint: string): Uint8Array {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.#key, iv, { authTagLength: 16 });
    c.setAAD(this.#aad(scope, fingerprint));
    const body = Buffer.concat([c.update(value, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }

  #open(sealed: Uint8Array, scope: VaultScope, fingerprint: string): string {
    const buf = Buffer.from(sealed);
    const d = createDecipheriv("aes-256-gcm", this.#key, buf.subarray(0, 12), { authTagLength: 16 });
    d.setAAD(this.#aad(scope, fingerprint));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
  }
}
