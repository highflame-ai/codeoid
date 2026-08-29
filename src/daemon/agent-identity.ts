/**
 * Agent Identity — registers Claude coding agents and sub-agents as ZeroID
 * identities with scoped, delegated tokens.
 *
 * Lifecycle:
 *   1. Session created → register agent identity in ZeroID, get token
 *   2. SubagentStart hook → register sub-agent, delegate token (attenuated)
 *   3. PreToolUse hook → audit tool call with agent's identity
 *   4. SubagentStop hook → deactivate sub-agent identity
 *   5. Session destroyed → deactivate agent identity, cascade revokes all tokens
 *
 * Delegation chain:
 *   human (owner) → codeoid session agent → sub-agent (explore, plan, etc.)
 *   Each level has scope intersection — sub-agent can only do what parent allows.
 */

import { type RegisterAgentRequest, ZeroIDClient } from "@highflame/sdk";
import { generateAgentKeypair, signActorAssertion } from "./agent-assertion.js";
import type { AuthConfig } from "./auth.js";
import { SCOPES } from "../protocol/scopes.js";
import type { Store } from "./store.js";

export interface AgentIdentityConfig {
  auth: AuthConfig;
  /** Account + project for ZeroID tenant scoping */
  accountId: string;
  projectId: string;
  /**
   * ZeroID registrar key (zid_sk_*) authenticating the daemon's admin calls
   * (agents.register / agents.deactivate). Injected per-sandbox (e.g. by
   * Forge). When present, the single #client exchanges it for a short-lived
   * Bearer so registration creates REAL identities against a secured ZeroID
   * instead of degrading to anonymous:*. Absent = unauthenticated admin calls
   * (a local/dev ZeroID that permits anonymous registration). Distinct from a
   * per-agent api_key: the #clientForAgent clients are NOT given this key.
   */
  registrarKey?: string;
  /**
   * RFC3339 expiry of the identity `registrarKey` belongs to — the per-sandbox
   * badge, when Forge injected one (`ZEROID_IDENTITY_EXPIRES_AT`).
   *
   * Every identity registered here is stamped with it, because ZeroID applies
   * no ceiling of its own: `allowed_scopes` passes through unvalidated at
   * register, and the tenant `default` credential policy carries an empty
   * `allowed_scopes`, which the subset check reads as "unrestricted". So a
   * badge holding `nhi:manage` and no `tools:*` could register a child holding
   * the full `tools:*` set — and, with no expiry, one that survived the
   * sandbox: `system:expired_sweep` deactivated the badge and left the child
   * `active`, a permanent credential in the user's project attributed to the
   * launching human (forge#110).
   *
   * Capping the lifetime does not close the scope gap — that needs the
   * register-time ceiling in ZeroID — but it does bound it to the sandbox that
   * opened it, which is the difference between a transient over-grant and a
   * standing one.
   *
   * Absent outside a sandbox: there is no badge to inherit from, and children
   * are already torn down with their session.
   */
  identityExpiresAt?: string;
  /**
   * Prefix for the conductor's ZeroID external_id. Defaults to
   * "codeoid-conductor"; integration tests override it so their throwaway
   * identities are unmistakable (codeoid-conductor-test-*) and sweepable.
   */
  conductorExternalIdPrefix?: string;
}

interface RegisteredAgent {
  identityId: string;
  wimseUri: string;
  token: string;
  apiKey: string;
  /**
   * The human owner (owner_user_id) this agent was registered for. Threaded to
   * sub-agents so they attribute to the SAME human owner — ZeroID derives
   * owner_user_id from `created_by`, and Studio's code-agent roster filters
   * `?owner_user_id=<human>`, so a sub-agent created_by the parent's WIMSE URI
   * would never surface there. Optional: worker identities (conductor dispatch)
   * carry a lineage `created_by`, not a human owner.
   */
  ownerSub?: string;
  /**
   * This agent's ZeroID `external_id` — used as the canonical
   * `parent_external_id` when registering its sub-agents.
   */
  externalId?: string;
  /**
   * For session agents: a ZeroID client authed with THIS agent's api_key, so
   * it can act as the delegation *subject* (orchestrator) when minting
   * delegated tokens for its sub-agents via `tokens.delegate`. Undefined for
   * sub-agents (they are actors, not orchestrators).
   */
  client?: ZeroIDClient;
}

/** Tool scopes for the coding agent — maps to what actions the agent can take. */
const AGENT_TOOL_SCOPES = [
  "tools:read", // Read, Grep, Glob
  "tools:write", // Write, Edit
  "tools:execute", // Bash
  "tools:agent", // Spawn sub-agents
] as const;

/**
 * Conductor scope profile (design R1) — the conductor routes work, it never
 * does work in a target session. Fleet visibility + dispatch only; the
 * deliberate absence of `tools:write` / `tools:execute` means that even a
 * fully-delegated chain rooted at the conductor can never mint a token that
 * edits or runs anything in a target (ZeroID grants the *intersection* of the
 * subject's scopes on every hop, so what the conductor lacks its whole
 * subtree lacks — read-only-by-construction, made cryptographic).
 */
export const CONDUCTOR_SCOPES = [
  SCOPES.SESSION_READ, // list / find / summarize the fleet
  SCOPES.SESSION_DISPATCH, // direct, interrupt, or spawn sessions
] as const;

/**
 * Worker scope profiles by dispatch shape (P4, hermes leaf/orchestrator).
 *
 * The LEAF property: no worker profile ever includes session:read /
 * session:dispatch / tools:agent-spawning-fleet authority — a worker cannot
 * see or direct the fleet even if fleet tools were somehow mounted on it.
 * The SHAPE property: scouts investigate-and-report, so their identity holds
 * no tools:write.
 *
 * Why the worker's token is a ROOT grant and not a conductor delegation:
 * ZeroID grants the intersection (requested ∩ subject.granted ∩
 * actor.allowed) on every RFC 8693 hop, and the conductor's own authority is
 * deliberately session:read/session:dispatch only — so a chain rooted at the
 * conductor can NEVER carry tools:write. That is R1 working as intended: the
 * conductor cannot mint mutation authority. A worker's tool capability is
 * instead sanctioned by the OWNER's explicit fleet_spawn approval (R3), and
 * the identity records `created_by = conductor WIMSE URI` for the audit
 * lineage. Revocation rides session teardown (deactivateSessionAgent), which
 * cascade-revokes the worker's own delegation subtree.
 */
const WORKER_SCOPE_PROFILES: Record<"ship" | "scout", readonly string[]> = {
  ship: ["tools:read", "tools:write", "tools:execute", "tools:agent"],
  scout: ["tools:read", "tools:execute", "tools:agent"],
};

/** Sub-agents get read-only by default unless explicitly promoted. */
const SUBAGENT_DEFAULT_SCOPES = ["tools:read"] as const;

/** Sub-agent scope overrides by agent type. */
const SUBAGENT_SCOPE_MAP: Record<string, readonly string[]> = {
  "general-purpose": ["tools:read", "tools:write", "tools:execute"],
  Explore: ["tools:read"],
  Plan: ["tools:read"],
};

/**
 * The durable conductor identity (design R2). Unlike session agents — which
 * are disposable and die with their session — the conductor's identity is
 * persisted to the Store and reloaded on daemon restart, so it keeps ONE
 * stable WIMSE URI for its whole lifetime. Only the api_key rests on disk;
 * the actor keypair is regenerated per process and re-registered with ZeroID.
 */
interface RegisteredConductor {
  identityId: string;
  wimseUri: string;
  apiKey: string;
  /**
   * ZeroID client authed as the conductor — the delegation *subject* when
   * the conductor later delegates to disposable child workers (P4).
   */
  client: ZeroIDClient;
  /**
   * Signs the conductor's actor assertions so the *owner* can delegate
   * `session:read session:dispatch` to it via RFC 8693 token exchange.
   * Process-local: regenerated (and re-registered) on every boot.
   */
  privateKey: CryptoKey;
}

export interface ConductorIdentity {
  identityId: string;
  wimseUri: string;
}

export class AgentIdentityManager {
  #client: ZeroIDClient;
  #store: Store;
  #config: AgentIdentityConfig;
  #agents = new Map<string, RegisteredAgent>();
  #conductor?: RegisteredConductor;

  constructor(config: AgentIdentityConfig, store: Store) {
    this.#config = config;
    this.#client = new ZeroIDClient({
      baseUrl: config.auth.baseUrl,
      accountId: config.accountId,
      projectId: config.projectId,
      // Registrar key (if injected) authenticates admin registration calls.
      apiKey: config.registrarKey,
    });
    this.#store = store;
  }

  /**
   * The lifetime ceiling stamped on every identity registered here — see
   * `AgentIdentityConfig.identityExpiresAt` for why (forge#110).
   *
   * Spread into the register body so an absent ceiling omits the field
   * entirely: sending an explicit null/empty would be a caller asserting "no
   * expiry", which is the behaviour being fixed rather than the default being
   * inherited.
   */
  #expiry(): { expires_at?: string } {
    const at = this.#config.identityExpiresAt;
    return at ? { expires_at: at } : {};
  }

  /**
   * A ZeroID client authed as a specific agent (by its api_key) — used as the
   * delegation *subject* (orchestrator) when minting delegated sub-agent
   * tokens. The api_key grant makes this client speak for that identity.
   */
  #clientForAgent(apiKey: string): ZeroIDClient {
    return new ZeroIDClient({
      baseUrl: this.#config.auth.baseUrl,
      accountId: this.#config.accountId,
      projectId: this.#config.projectId,
      apiKey,
    });
  }

  /**
   * Register a coding agent identity when a session is created.
   * Returns the WIMSE URI for audit attribution.
   */
  async registerSessionAgent(
    sessionId: string,
    sessionName: string,
    ownerSub: string,
  ): Promise<{ wimseUri: string; token: string }> {
    const externalId = `codeoid-session-${sessionId.slice(0, 8)}`;

    try {
      // The session agent is the delegation *subject*: it can only grant a
      // sub-agent scopes it holds itself, so it must be registered with the
      // full tool-scope ceiling. (`allowed_scopes`, like `public_key_pem`, is
      // server-accepted but missing from the SDK's RegisterAgentRequest type
      // through 0.3.17 — widen the literal to attach it.)
      const registerReq = {
        name: `codeoid/${sessionName}`,
        external_id: externalId,
        ...this.#expiry(),
        // A coding agent — `identity_type=agent` types the node in the ZeroID
        // registry / delegation explorer, and `sub_type=code_agent` (accepted
        // by ZeroID's register enum) is the accurate role, matching how
        // Cerberus registers Overwatch coding agents. Without these the node
        // rendered with no/wrong type.
        identity_type: "agent" as const,
        sub_type: "code_agent" as const,
        trust_level: "first_party" as const,
        framework: "claude-agent-sdk",
        publisher: "codeoid",
        // created_by = the human owner ⇒ ZeroID stamps owner_user_id, so the
        // agent surfaces in Studio's code-agent roster (filters owner_user_id).
        created_by: ownerSub,
        allowed_scopes: [...AGENT_TOOL_SCOPES],
        metadata: JSON.stringify({
          session_id: sessionId,
          session_name: sessionName,
          owner_user_id: ownerSub,
        }),
      };
      const resp = await this.#client.agents.register(
        registerReq as RegisterAgentRequest,
      );

      // Issue a scoped token for the agent via delegation
      const tokenResp = await this.#client.tokens.issueApiKey(resp.api_key, {
        scope: AGENT_TOOL_SCOPES.join(" "),
      });

      const agent: RegisteredAgent = {
        identityId: resp.identity.id,
        wimseUri: resp.identity.wimse_uri,
        token: tokenResp.access_token,
        apiKey: resp.api_key,
        // Threaded to sub-agents: the human owner + this agent's external_id,
        // so a sub-agent attributes to the same owner and links back here.
        ownerSub,
        externalId,
        // Orchestrator client — lets this session agent grant delegated
        // authority to its sub-agents (it is the delegation subject).
        client: this.#clientForAgent(resp.api_key),
      };

      this.#agents.set(sessionId, agent);

      this.#store.audit(
        agent.wimseUri,
        "agent.identity.registered",
        sessionId,
        `external_id=${externalId}`,
      );

      return { wimseUri: agent.wimseUri, token: agent.token };
    } catch (err) {
      // Non-fatal — identity registration is best-effort. Session still works.
      console.error(
        `[codeoid] failed to register agent identity for session ${sessionName}:`,
        err instanceof Error ? err.message : err,
      );
      return { wimseUri: `anonymous:session:${sessionId}`, token: "" };
    }
  }

  /**
   * Register a dispatch-spawned WORKER identity (P4). Shape-capped LEAF
   * profile (see WORKER_SCOPE_PROFILES for why the token is a root grant
   * sanctioned by the owner's fleet_spawn approval, not a conductor
   * delegation), with `created_by` = the conductor's WIMSE URI so the audit
   * lineage reads owner → conductor → worker. Stored under the session id
   * like any session agent, so tool audit and teardown cascade unchanged.
   */
  async registerWorker(
    sessionId: string,
    sessionName: string,
    shape: "ship" | "scout",
  ): Promise<{ wimseUri: string; token: string }> {
    const externalId = `codeoid-worker-${sessionId.slice(0, 8)}`;
    const scopes = WORKER_SCOPE_PROFILES[shape];
    const lineage = this.#conductor?.wimseUri ?? "codeoid:dispatch";

    try {
      const registerReq = {
        name: `codeoid/worker/${shape}/${sessionName}`,
        external_id: externalId,
        ...this.#expiry(),
        identity_type: "agent" as const,
        sub_type: "tool_agent" as const,
        trust_level: "first_party" as const,
        framework: "claude-agent-sdk",
        publisher: "codeoid",
        created_by: lineage,
        allowed_scopes: [...scopes],
        metadata: JSON.stringify({
          session_id: sessionId,
          role: "worker",
          shape,
          spawned_by: lineage,
        }),
      };
      const resp = await this.#client.agents.register(
        registerReq as RegisterAgentRequest,
      );

      const tokenResp = await this.#client.tokens.issueApiKey(resp.api_key, {
        scope: scopes.join(" "),
      });

      this.#agents.set(sessionId, {
        identityId: resp.identity.id,
        wimseUri: resp.identity.wimse_uri,
        token: tokenResp.access_token,
        apiKey: resp.api_key,
        // Orchestrator client for the worker's OWN sub-agents (Explore etc.)
        // — their delegated scopes intersect with the shape profile, so a
        // scout's sub-agents can't hold tools:write either.
        client: this.#clientForAgent(resp.api_key),
      });

      this.#store.audit(
        resp.identity.wimse_uri,
        "worker.identity.registered",
        sessionId,
        `shape=${shape} spawned_by=${lineage} scopes=${scopes.join(",")}`,
      );

      return { wimseUri: resp.identity.wimse_uri, token: tokenResp.access_token };
    } catch (err) {
      console.error(
        `[codeoid] failed to register worker identity for ${sessionName}:`,
        err instanceof Error ? err.message : err,
      );
      return { wimseUri: `anonymous:worker:${sessionId}`, token: "" };
    }
  }

  /**
   * Register a sub-agent identity when Claude spawns one (SubagentStart hook).
   * Token is delegated from the parent session agent with attenuated scopes.
   */
  async registerSubagent(
    sessionId: string,
    agentId: string,
    agentType: string,
  ): Promise<{ wimseUri: string }> {
    const parent = this.#agents.get(sessionId);
    if (!parent) {
      return { wimseUri: `anonymous:subagent:${agentId}` };
    }

    const externalId = `codeoid-subagent-${agentId.slice(0, 12)}`;
    const scopes = SUBAGENT_SCOPE_MAP[agentType] ?? SUBAGENT_DEFAULT_SCOPES;

    try {
      // The sub-agent is the delegation *actor*, so it must self-sign an actor
      // assertion — generate its EC keypair up front and register the public
      // key, which ZeroID validates the assertion against.
      const keypair = await generateAgentKeypair();
      // `public_key_pem` is accepted by ZeroID's register endpoint but is
      // absent from the SDK's RegisterAgentRequest type (through 0.3.17), so
      // widen the literal to attach it without an excess-property error.
      const registerReq = {
        name: `codeoid/${agentType}/${agentId.slice(0, 8)}`,
        external_id: externalId,
        ...this.#expiry(),
        identity_type: "agent" as const,
        sub_type: "tool_agent" as const,
        trust_level: "first_party" as const,
        framework: "claude-agent-sdk",
        publisher: "codeoid",
        // owner_user_id (ZeroID derives it from created_by) must be the HUMAN
        // owner — not the parent agent's WIMSE URI, or the sub-agent is
        // attributed to the parent and never appears in Studio's code-agent
        // roster (?owner_user_id=<human>). The parent-agent linkage is carried
        // separately: the canonical parent_* metadata below (for the registry)
        // and the real RFC 8693 delegation credential (parent_jti) minted just
        // after. Fall back to the parent's WIMSE URI only if no owner is known
        // (e.g. a worker-spawned sub-agent), preserving prior behavior.
        created_by: parent.ownerSub ?? parent.wimseUri,
        allowed_scopes: [...scopes],
        public_key_pem: keypair.publicKeyPem,
        metadata: JSON.stringify({
          session_id: sessionId,
          owner_user_id: parent.ownerSub,
          // Canonical parent-linkage keys the ZeroID registry / delegation
          // explorer read (previously an ad-hoc `parent_agent`, which nothing
          // consumed).
          parent_wimse_uri: parent.wimseUri,
          parent_external_id: parent.externalId,
          parent_session_id: sessionId,
          agent_type: agentType,
        }),
      };
      const resp = await this.#client.agents.register(
        registerReq as RegisterAgentRequest,
      );

      // Real RFC 8693 delegation: the sub-agent self-signs an actor assertion
      // (iss = its WIMSE URI); the parent session agent (orchestrator) is the
      // *subject*. We pass the parent's ALREADY-SCOPED access token
      // (`parent.token`, minted with the agent tool ceiling) explicitly as the
      // subject_token — the proven flow from the live integration test
      // (conductor-zeroid.test.ts: `issueTokenExchange(subjectToken, actor)`).
      //
      // This replaces `parent.client.tokens.delegate()`, which let the SDK mint
      // the subject token implicitly via an api_key exchange WITHOUT requesting
      // the tool scopes — so the three-way intersection (requested ∩ subject ∩
      // actor) stripped everything and the exchange failed, silently degrading
      // every sub-agent to an orphaned root token (no `parent_jti` edge). The
      // result carries a verifiable `act` chain (session-agent ← sub-agent) and
      // an incremented `delegation_depth`; deactivating the parent invalidates
      // it by construction (revocation-aware).
      let token = "";
      let delegated = false;
      if (parent.token) {
        try {
          const assertion = await signActorAssertion(
            keypair.privateKey,
            resp.identity.wimse_uri,
            this.#config.auth.baseUrl,
          );
          const delegatedResp = await this.#client.tokens.issueTokenExchange(
            parent.token,
            assertion,
            { scope: scopes.join(" ") },
          );
          token = delegatedResp.access_token;
          delegated = true;
        } catch (err) {
          // Delegation failed. This is now a LOUD, audited degradation — not a
          // silent one: falling back to an undelegated root token keeps the
          // session working, but the sub-agent has NO `parent_jti` edge and so
          // appears orphaned in the delegation graph. Surface it so operators
          // can see and fix the underlying cause instead of it passing quietly.
          console.error(
            `[codeoid] subagent delegation FAILED for ${agentType} (parent=${parent.wimseUri}) — falling back to an UNDELEGATED root token; the sub-agent will be ORPHANED in the delegation graph. cause:`,
            err instanceof Error ? err.message : err,
          );
          this.#store.audit(
            resp.identity.wimse_uri,
            "subagent.delegation.failed",
            sessionId,
            `type=${agentType} parent=${parent.wimseUri} cause=${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (!delegated) {
        token = (await this.#client.tokens.issueApiKey(resp.api_key))
          .access_token;
      }

      this.#agents.set(`${sessionId}:${agentId}`, {
        identityId: resp.identity.id,
        wimseUri: resp.identity.wimse_uri,
        token,
        apiKey: resp.api_key,
      });

      this.#store.audit(
        resp.identity.wimse_uri,
        "subagent.identity.registered",
        sessionId,
        `type=${agentType} parent=${parent.wimseUri} ${
          delegated ? "delegated" : "(undelegated)"
        }`,
      );

      return { wimseUri: resp.identity.wimse_uri };
    } catch (err) {
      console.error(
        "[codeoid] failed to register subagent identity:",
        err instanceof Error ? err.message : err,
      );
      return { wimseUri: `anonymous:subagent:${agentId}` };
    }
  }

  /**
   * Audit a tool call attributed to the session agent's identity.
   */
  auditToolCall(sessionId: string, toolName: string, _toolInput: string): void {
    const agent = this.#agents.get(sessionId);
    const sub = agent?.wimseUri ?? `anonymous:session:${sessionId}`;
    this.#store.audit(sub, "agent.tool_call", sessionId, `tool=${toolName}`);
  }

  /**
   * Deactivate a sub-agent identity (SubagentStop hook).
   */
  async deactivateSubagent(sessionId: string, agentId: string): Promise<void> {
    const key = `${sessionId}:${agentId}`;
    const agent = this.#agents.get(key);
    if (!agent) return;

    try {
      await this.#client.agents.deactivate(agent.identityId);
      this.#store.audit(
        agent.wimseUri,
        "subagent.identity.deactivated",
        sessionId,
      );
    } catch (err) {
      // A failed revocation leaves the token ACTIVE — log it (don't swallow),
      // matching deactivateConductor. The local row is still dropped below.
      //
      // ALSO audited, not just logged: a register/deactivate count mismatch is
      // how a leaked credential is found after the fact, and without this row
      // the forensics cannot distinguish "daemon died before deactivating"
      // from "deactivation was attempted and failed". A real investigation hit
      // exactly that ambiguity (one identity, 11 registered / 10 deactivated).
      this.#store.audit(
        agent.wimseUri,
        "subagent.identity.deactivation_failed",
        sessionId,
        err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      );
      console.error(
        `[codeoid] failed to deactivate subagent identity ${agent.wimseUri} (token may remain active):`,
        err instanceof Error ? err.message : err,
      );
    }
    this.#agents.delete(key);
  }

  /**
   * Deactivate a session agent identity — cascades to revoke all sub-agent tokens.
   */
  async deactivateSessionAgent(sessionId: string): Promise<void> {
    const agent = this.#agents.get(sessionId);
    if (!agent) return;

    // Deactivate all sub-agents for this session
    for (const [key, subagent] of this.#agents) {
      if (key.startsWith(`${sessionId}:`) && key !== sessionId) {
        try {
          await this.#client.agents.deactivate(subagent.identityId);
          // The cascade path never audited its successes, so identities
          // revoked at session destroy looked identical to leaks when pairing
          // registered/deactivated rows. Same row the direct path writes.
          this.#store.audit(subagent.wimseUri, "subagent.identity.deactivated", sessionId);
        } catch (err) {
          this.#store.audit(
            subagent.wimseUri,
            "subagent.identity.deactivation_failed",
            sessionId,
            err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
          );
          console.error(
            `[codeoid] failed to deactivate subagent identity ${subagent.wimseUri} (token may remain active):`,
            err instanceof Error ? err.message : err,
          );
        }
        this.#agents.delete(key);
      }
    }

    // Deactivate the session agent itself
    try {
      await this.#client.agents.deactivate(agent.identityId);
      this.#store.audit(
        agent.wimseUri,
        "agent.identity.deactivated",
        sessionId,
      );
    } catch (err) {
      console.error(
        `[codeoid] failed to deactivate session-agent identity ${agent.wimseUri} (token may remain active):`,
        err instanceof Error ? err.message : err,
      );
    }
    this.#agents.delete(sessionId);
  }

  /**
   * Get the WIMSE URI for a session agent.
   */
  getAgentUri(sessionId: string): string | undefined {
    return this.#agents.get(sessionId)?.wimseUri;
  }

  /**
   * The credential a session's agent should present on LLM-gateway calls
   * (forge#111) — its own api_key, which ZeroID resolves to a token carrying
   * `AGENT_TOOL_SCOPES`.
   *
   * The api_key rather than the stored access token, because that is the shape
   * the gateway's `x-highflame-apikey` header already carries: Forge puts the
   * sandbox badge's api_key there and the gateway exchanges it. Handing back
   * the same shape keeps the swap a substitution rather than a protocol change.
   *
   * Undefined when no identity is registered for the session — registration is
   * best-effort by design, and the caller leaves the launch-time credential
   * alone rather than inventing one.
   */
  getGatewayCredential(sessionId: string): string | undefined {
    return this.#agents.get(sessionId)?.apiKey;
  }

  // ── Conductor identity (durable, owner-delegated — design R1/R2) ──────

  /** The conductor's stable WIMSE URI, when one is registered/resumed. */
  get conductorUri(): string | undefined {
    return this.#conductor?.wimseUri;
  }

  /**
   * Ensure the durable conductor identity exists: reuse the in-memory one,
   * else reload the persisted one from the Store, else register a fresh
   * identity in ZeroID (scope ceiling = CONDUCTOR_SCOPES) and persist it.
   * Best-effort like the rest of the identity layer — returns null on
   * failure so the daemon keeps working without a conductor identity.
   */
  async registerConductor(ownerSub: string): Promise<ConductorIdentity | null> {
    const resumed = await this.resumeConductor();
    if (resumed) return resumed;

    const prefix = this.#config.conductorExternalIdPrefix ?? "codeoid-conductor";
    // Unique per registration — durability comes from the Store row, not from
    // external_id reuse (a deactivated identity keeps its external_id, so a
    // stable one would collide on legitimate re-registration).
    const externalId = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

    try {
      // The conductor is both a delegation *actor* (the owner delegates
      // session:read/session:dispatch TO it) and a future *subject* (it
      // delegates onward to disposable child workers) — so it registers a
      // public key for actor assertions AND gets an api_key for the
      // orchestrator client. (`allowed_scopes` / `public_key_pem` are
      // server-accepted but missing from the SDK type through 0.3.17.)
      const keypair = await generateAgentKeypair();
      const registerReq = {
        name: "codeoid/conductor",
        external_id: externalId,
        ...this.#expiry(),
        identity_type: "agent" as const,
        sub_type: "orchestrator" as const,
        trust_level: "first_party" as const,
        framework: "claude-agent-sdk",
        publisher: "codeoid",
        created_by: ownerSub,
        allowed_scopes: [...CONDUCTOR_SCOPES],
        public_key_pem: keypair.publicKeyPem,
        metadata: JSON.stringify({ role: "conductor", owner: ownerSub }),
      };
      const resp = await this.#client.agents.register(
        registerReq as RegisterAgentRequest,
      );

      // Persist BEFORE exposing the in-memory identity: if the Store write
      // fails, callers must see the registration as failed rather than a
      // "durable" conductor that would vanish on the next restart.
      this.#store.saveConductorIdentity({
        accountId: this.#config.accountId,
        projectId: this.#config.projectId,
        identityId: resp.identity.id,
        wimseUri: resp.identity.wimse_uri,
        apiKey: resp.api_key,
      });
      this.#conductor = {
        identityId: resp.identity.id,
        wimseUri: resp.identity.wimse_uri,
        apiKey: resp.api_key,
        client: this.#clientForAgent(resp.api_key),
        privateKey: keypair.privateKey,
      };

      this.#store.audit(
        resp.identity.wimse_uri,
        "conductor.identity.registered",
        undefined,
        `external_id=${externalId} owner=${ownerSub}`,
      );

      return { identityId: resp.identity.id, wimseUri: resp.identity.wimse_uri };
    } catch (err) {
      console.error(
        "[codeoid] failed to register conductor identity:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Reload the persisted conductor identity on daemon restart (called from
   * SessionManager.resumeSessions). Reuses the stored identity — same
   * identityId, same WIMSE URI — instead of re-registering, and rotates the
   * process-local actor keypair with ZeroID so owner→conductor delegation
   * keeps working. Returns null when nothing is persisted or the stored
   * identity is no longer usable (deactivated / api_key revoked), in which
   * case the stale row is dropped so the next registerConductor starts clean.
   */
  async resumeConductor(): Promise<ConductorIdentity | null> {
    if (this.#conductor) {
      return {
        identityId: this.#conductor.identityId,
        wimseUri: this.#conductor.wimseUri,
      };
    }

    const row = this.#store.getConductorIdentity(
      this.#config.accountId,
      this.#config.projectId,
    );
    if (!row) return null;

    try {
      // Liveness probe: minting from the api_key fails iff the identity was
      // deactivated or the key revoked — exactly the cases where the stored
      // row is dead and a fresh registration is the right call.
      await this.#client.tokens.issueApiKey(row.apiKey);
    } catch (err) {
      console.error(
        "[codeoid] persisted conductor identity is no longer usable, dropping:",
        err instanceof Error ? err.message : err,
      );
      this.#store.deleteConductorIdentity(
        this.#config.accountId,
        this.#config.projectId,
      );
      this.#store.audit(
        row.wimseUri,
        "conductor.identity.dropped_stale",
        undefined,
        `identity_id=${row.identityId}`,
      );
      return null;
    }

    // The previous process's actor private key died with it — register a
    // fresh public key under the SAME identity so assertions keep verifying.
    // Durable identity, ephemeral keys.
    const keypair = await generateAgentKeypair();
    try {
      await this.#client.identities.update(row.identityId, {
        public_key_pem: keypair.publicKeyPem,
      });
    } catch (err) {
      // Keep the resumed identity (URI stability wins) — delegation will
      // surface a clear assertion-verification error if this mattered.
      console.error(
        "[codeoid] failed to rotate conductor actor key (delegation may fail):",
        err instanceof Error ? err.message : err,
      );
    }

    this.#conductor = {
      identityId: row.identityId,
      wimseUri: row.wimseUri,
      apiKey: row.apiKey,
      client: this.#clientForAgent(row.apiKey),
      privateKey: keypair.privateKey,
    };

    this.#store.audit(
      row.wimseUri,
      "conductor.identity.resumed",
      undefined,
      `identity_id=${row.identityId}`,
    );

    return { identityId: row.identityId, wimseUri: row.wimseUri };
  }

  /**
   * Mint the conductor's working token by OWNER delegation (RFC 8693): the
   * owner's subject token grants, the conductor's self-signed assertion
   * acts. The result carries `delegation_depth: 1`, an `act` chain rooted at
   * the owner, and at most CONDUCTOR_SCOPES (three-way scope intersection) —
   * so the conductor acts on the owner's behalf, never on its own authority,
   * and deactivating either end kills the token.
   */
  async mintConductorToken(ownerSubjectToken: string): Promise<string | null> {
    const conductor = this.#conductor;
    if (!conductor) return null;

    try {
      const assertion = await signActorAssertion(
        conductor.privateKey,
        conductor.wimseUri,
        this.#config.auth.baseUrl,
      );
      const resp = await this.#client.tokens.issueTokenExchange(
        ownerSubjectToken,
        assertion,
        { scope: CONDUCTOR_SCOPES.join(" ") },
      );
      this.#store.audit(
        conductor.wimseUri,
        "conductor.token.delegated",
        undefined,
        `scope=${resp.scope ?? ""}`,
      );
      return resp.access_token;
    } catch (err) {
      console.error(
        "[codeoid] owner->conductor delegation failed:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Deactivate the conductor identity. ZeroID cascade-revokes every active
   * credential in its delegation subtree (owner-delegated conductor token,
   * child-worker tokens, their sub-agent tokens) via the parent_jti chain —
   * one call kills the whole tree. On success the persisted row is cleared
   * so the next registerConductor starts a fresh identity; on failure the
   * row is KEPT — it's the only durable record of an identity that is still
   * live in ZeroID, and a later deactivateConductor() retries against it.
   */
  async deactivateConductor(): Promise<void> {
    const conductor = this.#conductor;
    const row =
      conductor ??
      this.#store.getConductorIdentity(
        this.#config.accountId,
        this.#config.projectId,
      );
    if (!row) return;

    // Stop using the identity locally regardless of the remote outcome —
    // the caller's intent is deactivation.
    this.#conductor = undefined;

    try {
      await this.#client.agents.deactivate(row.identityId);
    } catch (err) {
      console.error(
        "[codeoid] failed to deactivate conductor identity (row kept for retry):",
        err instanceof Error ? err.message : err,
      );
      return;
    }
    this.#store.audit(
      row.wimseUri,
      "conductor.identity.deactivated",
      undefined,
      `identity_id=${row.identityId}`,
    );
    this.#store.deleteConductorIdentity(
      this.#config.accountId,
      this.#config.projectId,
    );
  }
}
