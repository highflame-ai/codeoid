# Codeoid Mobile App — Design & Tech-Stack Decision

> Status: **proposal** · Supersedes the stack recommendation in issue #43 · Depends on #42 (OAuth) · Conductor-aware (draft PR #51)
>
> Scope: a native iOS + Android client for the Codeoid daemon. The bar is *world-class* — faster and better-feeling than any coding/work app in this category — with **voice-first** control as a first-class mode, and an information architecture that graduates cleanly into the **conductor** (personal-assistant-over-a-fleet) model.

---

## 0. TL;DR — the decisions

| Decision | Recommendation | Why in one line |
| --- | --- | --- |
| **UI runtime** | **Expo + React Native (SDK 57 / RN 0.86)** — *not* Capacitor | Every hard requirement (fast virtualized streaming chat, voice-first, native push, OTA) has a mature, purpose-built answer in RN today; Capacitor caps the "feels native" ceiling exactly where our bar is highest. |
| **Web-UI reuse** | Reuse the **logic**, rewrite the **pixels**. Extract `@highflame/codeoid-protocol` + `@highflame/codeoid-core` (wire types, WS client, reducers, formatters) and share across daemon-web + mobile. | The valuable, portable 90% is the protocol/state layer, not the `.tsx`. Capacitor reuses the *wrong* 90%. |
| **Conductor readiness** | Build around the existing attach/scrollback model; make "the conductor" a pinnable **home surface**, session list a secondary **fleet view**. | Conductor is a *session role* driven by MCP tools — **zero new client↔daemon wire types**. The app that talks to one session already talks to the conductor. |
| **Auth** | Daemon URL → ZeroID API key **or** Google OAuth→ZeroID; token in device **Keychain/Keystore** (`expo-secure-store`), never localStorage. | Matches the daemon's existing two auth paths; #42 unblocks the OAuth leg. |
| **Push** | Ship a small **OSS relay** that holds APNs/FCM creds; daemon POSTs an (E2E-encrypted) event, relay fans out. Add `push.register`/`push.unregister` to the protocol. | A self-hosted daemon can't push to Apple/Google directly. This relay is also the natural **hosted/paid** surface. |
| **Open source?** | **Yes — open-source the client under a permissive license (Apache-2.0/MIT), open-core.** Monetize the **hosted relay + conductor cloud + ZeroID SaaS**, not the app binary. | This is a control plane holding keys to the user's machine; for this audience, a closed client is a trust non-starter. The moat is the daemon + conductor + identity + hosted relay, never the pixels. |

---

## 1. Goals & non-goals

**Goals**
- A genuinely native-feeling iOS + Android app: 120 Hz-smooth virtualized streaming transcript, instant session switching, no webview tells.
- **Voice-first**: dictate prompts, hear agent progress, and **approve/deny tool calls by voice** — usable hands-free (walking, driving, away from keyboard).
- Connect to any daemon by URL, authenticate with a ZeroID key **or** OAuth, store credentials in the platform secure store.
- **Push notifications** for the one thing a phone is uniquely good at: *"a session is blocked waiting on your approval."*
- An IA that becomes the **conductor** ("talk to your assistant; it runs the fleet") without a rewrite.

**Non-goals (v1)**
- Editing files on-device / full IDE surface (read-only file peek is enough; the daemon is the source of truth).
- Replacing the Solid web UI or the Rust TUI — this is a *third* first-class frontend, peer to them.
- A bespoke sub-100 ms audio DSP pipeline (we lean on vendor voice SDKs; revisit only if latency becomes the product).

---

## 2. Where this diverges from issue #43 (and why)

Issue #43 recommends **Capacitor wrapping the existing SolidJS web UI** ("~90% reuse"), with React Native listed as the deferred alternative. This proposal **reverses that** for the end-state, while keeping #43's good instincts (PWA as a fast validation step, keychain tokens, deep-link OAuth, a push-token registration endpoint).

The reversal turns on our own bar — *"world-class, better than any work/code app, really fast, full voice-first."* Capacitor's documented, structural failure modes land precisely on those axes:
- **Chat composer + keyboard**: WKWebView keyboard-resize choreography in a text-field-centric app is the #1 "this feels webby" tell, even with modern plugins.
- **Long virtualized transcript**: webview scroll physics on a streaming, virtualized list are good-but-not-native; we're targeting native.
- **Voice**: mic/audio-session control routed through plugins is a worse foundation than a first-class audio runtime for a voice-first product.
- **OTA**: no story as clean as EAS Update.

The "90% reuse" claim is real but **reuses the wrong 90%** — the UI pixels. The *actually* portable and valuable 90% (wire types, WS client, state reducers, formatters) ports to **React Native too**; RN only forces a rewrite of the `.tsx` components, which are the cheap, replaceable layer (see §4). Net: Capacitor buys weeks of speed today and a forced RN migration later once it succeeds.

**Kept from #43:** PWA (manifest + service worker on `web/`) as a 1-week installable validation build and permanent desktop-web "add to home screen" path; Keychain token storage; `codeoid://` deep-link OAuth callback; a daemon push-token registration endpoint (we make it a protocol message, §7).

---

## 3. Tech-stack decision — Expo / React Native

**Chosen: Expo SDK 57 + React Native 0.86** (New Architecture only; Hermes V1 default).

State of the stack (mid-2026), the parts that matter for us:
- **New Architecture is finished, not in-flight** — bridgeless is the only thing that ships; two consecutive RN releases (0.83, 0.86) with zero breaking changes. Hermes V1 is the default compiler/GC.
- **Streaming chat is now a solved category in RN:**
  - **FlashList v2** (Shopify) — rewritten for the New Architecture, `maintainVisibleContentPosition` on by default, purpose-built for chat/feed UIs including non-inverted chat.
  - **react-native-streamdown** (Software Mansion Labs) — parses *incomplete* markdown on a background thread via worklets, so the JS thread stays free during token floods. GFM + LaTeX + code. This is exactly our transcript's hardest problem.
- **Voice is best-in-class here:** `expo-audio` `useAudioStream` (realtime mic), `expo-speech-recognition` (New-Arch TurboModule over iOS `SFSpeechRecognizer` / Android `SpeechRecognizer`), `expo-speech` (TTS), plus first-class **LiveKit** and **ElevenLabs Agents** Expo plugins for full conversational voice. No other cross-platform stack has this density of voice-AI SDKs.
- **OTA that a 2-person team needs:** EAS Update with Hermes-bytecode diffing (~75 % smaller downloads), policy-compliant under Apple §3.3.1(B) for JS-only fixes (new features still go through review).
- **Reuse from our TS codebase:** business logic, protocol client, types, and streaming/formatting utilities port nearly verbatim; only the view layer is rewritten in React idioms.

Alternatives, and why not:

| Option | Verdict | Reason for a 2-dev, TS-owning team |
| --- | --- | --- |
| **Capacitor 8** | Runner-up / stopgap only | Ships the Solid UI as-is in weeks, but a permanently lower native ceiling on keyboard/scroll/voice — and success forces an RN migration anyway. |
| **Flutter 3.44** | Skip | Excellent runtime (Impeller), but **0 % reuse** (Dart), a second language + toolchain, no OTA without third-party Shorebird, and no equivalent to off-thread streaming markdown. |
| **KMP + Compose MP 1.11** | Skip | Best "share logic, native UI" story *for a Kotlin team*; for us it's Kotlin+Gradle+Xcode with zero Solid/TS reuse and the thinnest voice-SDK ecosystem. iOS text input only went native-backed in 1.11 — telling for a text-field app. |
| **Dual native (SwiftUI + Compose)** | Skip unless voice latency *is* the product | ~1.8× sustained effort, two review pipelines, no OTA, both devs fluent in Swift *and* Kotlin. |
| **Solid → native (Lynx / NativeScript / solid-native)** | Disqualified | No production-viable path in 2026: `solid-native` dead (last push Nov 2023), Lynx-for-Solid a stalled discussion with no core-team engagement, NativeScript+Solid has no documented production users. Our Solid investment transfers as *skills*, not code. |
| **Tauri v2 mobile** | Skip | Official notifications are **local-only (no server push)**; Rust-side native modules are the wrong skill axis. Desktop-first tech. |

---

## 4. Code-reuse strategy — extract `@highflame/codeoid-core`

Today the wire contract is **triplicated**: the canonical `src/protocol/types.ts` (daemon), a hand-maintained partial mirror in `web/src/protocol/types.ts` ("keep them in sync"), and a serde port in the Rust `codeoid-protocol` crate. A React Native app naïvely becomes a **fourth** hand-maintained copy. Fix that *before* building the app.

**Extract two publishable TS packages** (Bun/pnpm workspace inside `codeoid`):

- **`@highflame/codeoid-protocol`** — pure wire types + `PROTOCOL_VERSION` + scopes, lifted from `src/protocol/types.ts`. The daemon, `web/`, and the mobile app all *import* it. Kills the manual web mirror. (The Rust crate stays a separate hand-tracked port — same as today; it already proves the extraction is clean.)
- **`@highflame/codeoid-core`** — framework-agnostic client logic:
  - `ws.ts` `CodeoidClient` — connect, first-frame auth handshake, request/response correlation, **exponential backoff + full jitter** reconnect, 20 s heartbeat. Uses only the WHATWG `WebSocket` global (RN ships one), so it drops in as-is; the `window`/`document` resume listeners are already `typeof window` guarded → swap for `AppState`/`NetInfo` on RN.
  - The **reducer bodies** from `state/messages.ts` / `sessions.ts` (upsert-by-`messageId`, in-place delta patch, dedupe-on-replay). These are already written to *"mirror the Rust TUI's MessageStore semantics"* — extract the pure logic, leave `createStore`/`produce` behind.
  - `lib/{format,identity,approvals,usage-days,sanitize-url}.ts` and `components/prompt/slash.ts` — all pure, already unit-tested. (The color helpers return Tailwind class strings; swap for RN style tokens.)

**What the mobile app builds new (thin):**
- The React view layer (transcript rows, tool-call/diff/markdown rendering, approval bar, session list, composer) — FlashList v2 + react-native-streamdown.
- State bindings: wrap the extracted reducers in the RN state lib of choice (Zustand/Legend-State), keeping reducer semantics identical to web + TUI.
- Platform glue: `expo-secure-store` token storage (replaces `localStorage` in `lib/auth.ts`), `AppState`/`NetInfo` resume, push handlers, voice modules.

**Repo shape:** keep the daemon in `codeoid` and extract `packages/protocol` + `packages/core` there (web consumes them locally). Put the app in a **new `codeoid-mobile` Expo repo** depending on the published packages — mirroring how the Rust TUI (`codeoid-ui`) is already a separate repo tracking the same spec. This keeps RN/Metro tooling out of the Bun daemon repo while ending type drift.

**Attach/streaming model the app must honor (unchanged on the wire):**
- On `session.attach` the daemon sends a **full `scrollback.replay`** (complete `SessionMessage[]`, deltas pre-merged) — no pagination exists. Streaming afterward is `session.message.delta` patched in place.
- **Caveat / must-handle:** issue **#84** — a large replay frame can exceed the WS backpressure limit and the daemon auto-closes the client (it prunes suspended mobile webviews aggressively). On flaky mobile links this is a real lockout risk. The app should tolerate `4003`/backpressure closes and reconnect; longer-term, a `readSince(timestamp)` incremental-catch-up path exists in `scrollback.ts` but is **not wired to any protocol message** — wiring it is the right server-side fix for mobile and should be tracked alongside this work.

---

## 5. Connection & auth

Flow (matches the daemon's existing surface):
1. **Daemon URL** entry (e.g. `https://myserver.example.com` or `http://192.168.1.x:7400`). App calls `GET /config` to discover `zeroid_url`, `GET /health` for version/compat.
2. **Auth — two paths, both already server-supported:**
   - **ZeroID API key** (`zid_sk_…`): POST `grant_type=api_key` to the daemon's same-origin `/oauth2/token` proxy → `access_token`. Works *today*; good for power users / headless setups.
   - **Google OAuth → ZeroID** (RFC 8693 token-exchange, PKCE): `/auth/authorize` in an in-app browser, `codeoid://` deep-link callback. **Blocked on #42** (web button + auth-code-grant confirmation). This is the low-friction default the mobile ticket wants.
3. **Token storage:** access token in **Keychain/Keystore via `expo-secure-store`**. Re-mint on reconnect (JWTs are short-lived; the daemon closes `4003` on expiry every message, so long sockets can't outlive the token).
4. WS connects to the daemon origin root with `{type:"auth", token}` as the first frame (10 s auth deadline). Scopes returned in `auth.ok` are the capability set (`session:*`, `fs:read`).

**Identity is a feature, not plumbing.** Every message carries `MessageIdentity {sub (WIMSE/SPIFFE URI), name, type}`; sessions carry `agentUri` + a `subagents[]` chain and a full delegation context (`delegationDepth`, `delegatedBy`, `accountId`, `projectId`). Surface this per-message and in the header — it's a genuine differentiator versus every competitor (see §9), and it's what makes the conductor's delegation tree legible on a phone.

---

## 6. Voice-first design (local-first)

The differentiator — and, per the competitor scan (§12), the clearest whitespace: **nobody verified shipping a private, on-device voice loop.** The reference the user cited (`iris`) turned out to be a useful *counter-example* on this point: iris is not local STT/TTS at all — it streams mic audio to Google's Gemini Live cloud and just uses Google's voice instead of ElevenLabs. Its **only** on-device piece is the "Hey Iris" wake word (an openWakeWord-style ONNX pipeline). So iris informs *what to reuse*, not the voice architecture itself.

**Recommended v1 loop (lowest risk, best effort/UX ratio) — all on-device:**
`push-to-talk (or VAD auto-endpoint) → system STT → app logic → system TTS`, using:
- **STT:** `expo-speech-recognition` (jamsch) — a New-Architecture TurboModule wrapping iOS `SFSpeechRecognizer` and Android `SpeechRecognizer`, with **on-device mode + interim/continuous results**. iOS 26's `SpeechAnalyzer`/`SpeechTranscriber` is the quality ceiling (OS-managed model assets = ~zero app-size cost; ~2× faster than Whisper Large-v3-Turbo) but has **no streaming RN wrapper yet** — a small custom Expo Module when we want it. For heavier offline needs, `react-native-sherpa-onnx` (STT/TTS/VAD/KWS in one TurboModule) or `whisper.rn` (Core ML on iOS; **Android is CPU-only and slower** — lean on Android's system recognizer there).
- **TTS:** system `AVSpeechSynthesizer` / Android `TextToSpeech` via `expo-speech` for v1 (instant, ~0 MB). **Kokoro-82M** (~80 MB, faster-than-realtime, via `react-native-executorch`) is the "neural upgrade" — the one on-device TTS people are actually shipping.
- **VAD:** Silero VAD (~2 MB ONNX, <1 ms/30 ms chunk) for auto-endpointing so the user doesn't tap to stop; WebRTC VAD as a cheap first gate.
- **Wake word:** **not v1.** A third-party always-on wake word runs on the app processor (no access to the OS "Hey Siri" DSP path) — real background-mic battery drain for marginal benefit. PTT + VAD gives ~90% of the UX. When we do add "hey codeoid": **openWakeWord's pretrained models are CC-BY-NC (non-commercial) — we'd train our own** (the embedding/melspec models are Apache-2.0); Picovoice Porcupine's free tier caps at 3 active users/month (commercial beyond that is enterprise pricing). iris's `wakeword-models/` shows exactly how to train a custom phrase.

**Conversational / hands-free (v1.5):** for a true away-from-keyboard mode, add full-duplex voice. Local-only conversational quality still trails cloud on noisy/accented/long-form audio, so this is the one place a **cloud fallback is defensible** — but keep on-device dictation as the always-available, private floor, and make cloud voice opt-in (LiveKit / ElevenLabs Agents / OpenAI Realtime all have Expo plugins). The app speaks a **summary** of each turn and reads out **approval requests**; the user responds by voice: *"approve," "deny," "show me the diff first."*

**What ports from iris (framework-agnostic patterns worth copying):**
- **Arm the wake word only while idle** — cheap on-device detection gates the expensive path, so "nothing leaves the device while asleep." Right shape for mobile battery + privacy.
- **In-code confirmation state machine** (iris's `hermesGate`: *propose → model reads back → user must actually speak → only then act*, with a TTL). This maps directly onto **voice approvals of tool calls** — enforce "confirm before side-effecting" in code, not by trusting the model. High-value for the conductor's confirm-before-send.
- **Barge-in via flush-all-playback** — stop every queued audio buffer + reset the clock on interrupt.
- **Non-blocking dispatch over a stream** — start work, return immediately, stream progress, speak on completion.

**Reference — OpenSuperWhisper (`starmel/OpenSuperWhisper`, MIT):** a 100%-local, hold-to-record dictation app that proves the private-voice UX works well. It's **macOS-only Swift**, so the *code doesn't port*, but two things do: (1) it validates **whisper.cpp + Whisper GGML `.bin` models** (and **NVIDIA Parakeet** as a fast alternative) as the local-STT family — and those models are the *public* weights from the whisper.cpp Hugging Face repo, not anything proprietary to the app, so "using their models" just means using Whisper/Parakeet, which is exactly what `whisper.rn` (mobile) and whisper-WASM / transformers.js (web) already consume; (2) its hold-to-record dictation-into-the-active-field interaction is the right v1 UX to copy. **Parakeet** (Parakeet-TDT) is worth benchmarking against Whisper-small/Moonshine — it's near-SOTA on English speed/accuracy and has ONNX/CoreML ports.

**Local voice in the web UI too — not just mobile (per the direction to add it there).** This is the right call: it makes **local voice a cross-client codeoid capability** rather than a mobile-only feature, which is a *stronger* wedge against Happy's cloud-only voice (§12). The one trap to avoid: the browser **Web Speech API is not local** — Chrome ships the audio to Google's cloud. To keep the "your voice never leaves your machine" guarantee in the web UI, run Whisper **in-browser** via **`@xenova/transformers` (transformers.js, ONNX + WebGPU)** or a **whisper.cpp WASM** build (Moonshine ONNX is a lighter option). Note the org already uses `@xenova/transformers` server-side (memory embeddings), so it's familiar. Ship it as **push-to-talk dictation into the composer** first, mirroring OpenSuperWhisper. Architecturally, put the STT behind a small **`@highflame/codeoid-core` `SpeechProvider` interface** with platform adapters — transformers.js/WASM for web, `whisper.rn`/system recognizer for mobile — so web, mobile, and (later) the TUI share one local-voice contract and one "off by default, on-device only" guarantee.

Voice maps onto existing protocol state with **no wire changes**: `waiting_approval` status + a `tool.state.phase === "waiting_confirmation"` carrying an `approvalId` → spoken prompt → `session.approve {approvalId, approved, updatedInput?}`.

---

## 7. Push notifications — the relay problem

The single most valuable thing a phone adds is: *"a session is blocked, waiting on your approval"* — delivered when the app is **not** attached. Today no push exists (`web/src/state/desktop-notifications.ts` only fires a local browser notification for the *focused* session while the tab is hidden; there are no `push.*` protocol types).

**Constraint:** a self-hosted daemon on the user's box cannot push to APNs/FCM directly — Apple/Google delivery requires provider credentials the daemon shouldn't hold, and on iOS there is **no UnifiedPush**; you must go through APNs.

**Hard iOS constraints that shape the whole design** (from the push research):
- **No background sockets.** iOS suspends the app shortly after backgrounding and gives no way to keep a TCP/WebSocket alive — so the persistent daemon socket is a *foreground-only* luxury; background delivery **must** be APNs.
- **No UnifiedPush on iOS** — APNs is mandatory. Silent/background push is best-effort and throttled, so never build "stay synced silently" on it; use **user-visible alert pushes** for anything the user must see.
- **4 KB payload cap** on APNs/FCM.

**Design (the Home Assistant / ntfy pattern — content-blind by architecture):**
- A small **relay service** (developer-operated) holds the APNs + FCM credentials — they can't ship to a user's daemon. The daemon POSTs an event to the relay; the relay fans out to the device token. Store **token + a per-day counter only** (HA's minimal-retention posture).
- **Content-blindness — prefer the ntfy poll-back pattern over rolling our own crypto:** the push carries only a routing id (a wake-up), and the iOS **Notification Service Extension fetches the real (encrypted) body from the daemon/relay and decrypts it** (key shared with the app via an App Group / Keychain). The relay never sees content and the 4 KB cap stops mattering. (Pattern A — encrypt a small body directly into the push — is fine for short alerts within 4 KB.)
- **Protocol additions:** `push.register` / `push.unregister` (device token, platform, relay endpoint) — the app registers its token with the daemon so the daemon knows where to POST.
- **Actionable Approve/Deny without opening the app:** define the notification action **without** `.foreground`; iOS launches the app in the background to handle it. But the background window is seconds and the phone usually **isn't on the daemon's LAN**, so the action should **POST the decision to the relay** (which the daemon is already connected to), *not* attempt a direct socket to the user's machine. The daemon picks up the `session.approve` via its own outbound relay connection.
- **Fast path to ship:** since the app is Expo/RN, **Expo Push** abstracts APNs+FCM for v1 (free, receipt tracking) — at the cost of routing through Expo's servers. Graduate to a direct `.p8` APNs + FCM HTTP v1 relay (a few hundred lines) when we want the content-blind self-host story.
- **Android:** send **notification messages (not data-only)** for time-sensitive pushes (data-only is unreliable in Doze). Offer **UnifiedPush** as a second transport for de-Googled users (RFC 8291 E2E built in); iOS always uses our APNs relay.
- **Self-hosters** can run their own relay (OSS it); most users point at **our hosted relay** — the natural paid surface (§8, and a proven model: Nabu Casa bundles exactly this).

---

## 8. Conductor-forward design (draft PR #51)

The conductor is *"an identity-native fleet supervisor"* — a session created with `role: "conductor"` that drives the fleet by calling an in-process `codeoid_fleet` MCP server (list / spawn / send / watch / summarize / interrupt sessions, cross-thread recall). Crucially for us: **it introduces no new client↔daemon message kinds** — the conductor is just a session, and its fleet actions render as ordinary tool calls in the transcript. Addressing is by **identity/delegation** (owner → conductor → child sessions), one revocation root, `delegation_depth` capped.

**What that means for the app — design for it now, ship it later:**
- **IA:** make **"the conductor" a pinnable home surface** — a persistent assistant chat you open to. The **session list becomes a secondary "fleet view."** The user talks to the conductor in natural language (*"continue the authz latest_only fix"*); it resolves the fuzzy reference to the right session across every workspace (the "session resolution" linchpin in PR #51). Voice-first + conductor = *"talk to your assistant, it runs the fleet"* — the world-class vision.
- **Approvals are the crown jewel here:** the conductor's **confirm-before-send** on any write into a user-owned session flows through the same `approvalId` mechanism — which we're already turning into native push + voice approvals. A phone that lets you supervise an autonomous fleet by approving/denying its cross-repo actions with your voice is the product no competitor has.
- **No blocking dependency:** because the conductor needs no wire changes, the app can build entirely on today's attach/scrollback/session-list model and light up the conductor surface the moment PR #51's later phases land. Watch the build plan (P0–P8) — *if* a later phase adds protocol messages we adopt them, but none exist today.

---

## 9. Open source — the recommendation

**Open-source the app. Permissive license (Apache-2.0, or MIT to match `codeoid`/`codeoid-ui`). Open-core.** This is the headline decision, and it's a clear yes.

**Why:**
- **This is a control plane holding keys to the user's machine.** The app asks for a ZeroID credential and remote access to the user's coding sessions. For the exact developer/security audience Codeoid targets, a **closed-source client asking for that is a trust non-starter**; OSS = auditability, which this audience demands.
- **Consistency + ethos.** `codeoid` and `codeoid-ui` are already public MIT. The product's entire premise is *"you run the daemon."* An OSS client matches that and unlocks contribution, sideload/F-Droid, and community trust.
- **Every credible peer is OSS or source-available** in this exact shape (self-hosted backend + open client): Happy (the OSS Claude Code mobile leader — MIT, ~22k stars), Home Assistant companion apps, plus the broader precedent set — Bitwarden, Element X, Tailscale clients. The pattern *"code is open, the App Store binary is the convenient path"* (OsmAnd, Bitwarden, HA) is the norm and a proven trust multiplier.
- **The moat was never the pixels.** It's the daemon, the conductor + cross-session memory, ZeroID identity/delegation, and the hosted relay. Open-sourcing the client gives away nothing defensible. This is **almost exactly the Tailscale shape** — open clients + open relay code, proprietary coordination/control plane as the paid product.

**License split (researched):**
- **Client → Apache-2.0.** Permissive kills the GPL-vs-App-Store conflict outright (the VLC saga: Apple pulled VLC in 2011 over GPL §6/§10 "no further restrictions" vs Apple's EULA device caps + ToS; even VLC had to relicense to LGPL/MPL to return). Apache-2.0's **explicit patent grant** (vs MIT's merely-implied one) is worth the small NOTICE-file overhead in the patent-heavy mobile world. It also lets **us** publish the App Store binary and add Apple's EULA on top without any conflict.
- **Server (relay + conductor cloud + identity/team) → AGPL-3.0 or proprietary, in separate repos.** AGPL closes the SaaS-rehosting loophole (a competitor hosting it must publish changes) — the Plausible/Elastic move. This is the standard "permissive client + copyleft server" combo.
- **Governance → DCO, not a CLA.** Because the commercial value lives in *separate* server repos (open-core, not dual-licensing the client), a `Signed-off-by` DCO documents provenance without the CLA/relicensing controversy (MongoDB's CLA-enabled AGPL→SSPL rug-pull is why contributors distrust CLAs). Add a CLA only if we ever want to fold community client code into a proprietary client build.
- **Distribution:** we publish the App Store binary; Android via **F-Droid** (reproducible build and/or our own F-Droid repo, like Bitwarden) + APK sideload.

**Monetization (open-core), so OSS ≠ no revenue:**
- **Hosted push relay** — the convenience most users won't self-host (§7); the relay *must* hold APNs/FCM creds that can't ship to users, which is a clean, defensible reason to host it. Content-blind (poll-back), so we carry no content liability.
- **Conductor cloud** — hosted fleet supervision / cross-session memory / always-on assistant.
- **ZeroID SaaS + team/enterprise** — identity, delegation policy, audit, SSO. This is where Highflame-adjacent value accrues.
- Precedent that this sustains revenue: **Tailscale** (OSS clients, paid coordination), **Home Assistant / Nabu Casa** (OSS + cloud subscription that literally sells remote access + push), **Bitwarden** ($100M raise, ~100% YoY, OSS + hosted/enterprise). **Do not model on Signal** — donations + a founder loan is not a business at this scale.

**What stays closed:** essentially nothing in the *client*. The mobile app, `@highflame/codeoid-protocol`, and `@highflame/codeoid-core` are all Apache-2.0; the revenue services are the separate AGPL/proprietary server repos.

---

## 10. Phased build plan

| Phase | Deliverable | Depends on |
| --- | --- | --- |
| **P0 — Extract core** | `@highflame/codeoid-protocol` + `@highflame/codeoid-core` published from `codeoid`; `web/` migrated off its manual type mirror onto the package (proves the extraction, ends drift). | — |
| **P0.5 — PWA (optional stopgap)** | `manifest.json` + service worker on `web/` for installability + validation. (Kept from #43.) | — |
| **P1 — RN skeleton + auth + attach** | `codeoid-mobile` Expo app: daemon-URL entry, `/config` discovery, **API-key auth** (works today), Keychain storage, WS connect, `session.list` + attach + full scrollback render, reconnect via `AppState`/`NetInfo`. | P0 |
| **P2 — Streaming transcript + approvals + push** | FlashList v2 + react-native-streamdown transcript, tool-call state machine + diff render, **approval bar**; `push.register`/`push.unregister` + **relay** (Expo Push → direct APNs/FCM) + actionable Approve/Deny (background action POSTs to relay). | P1; server: push endpoint |
| **P3 — OAuth login** | Google OAuth→ZeroID with `codeoid://` deep-link callback (the friction-free default). | #42 |
| **P4 — Voice** | Dictation (`expo-speech-recognition`), then conversational hands-free mode (LiveKit/ElevenLabs) with spoken summaries + **voice approvals**. | P2 |
| **P5 — Conductor surface** | Conductor-as-home IA, fleet view, cross-workspace session resolution surfaced; light up as PR #51 phases land. | PR #51 |

---

## 11. Open questions / risks

- **#84 backpressure lockout** — ✅ **fixed in PR #100** (chunked, drain-paced scrollback replay; also speeds first paint in web + TUI). The remaining, optional server improvement is wiring `scrollback.readSince()` to an incremental-catch-up message to cut reconnect bandwidth on flaky mobile links — schedule with P2.
- **OAuth (#42)** gates the friction-free login; P1 ships on the API-key path so mobile isn't blocked on it.
- **Actionable-notification background approval** on iOS: resolved direction (§7) — the action POSTs the decision to the relay (phone usually isn't on the daemon LAN), daemon picks it up over its outbound relay connection. Confirm the NSE decrypt + App-Group key sharing during P2.
- **Voice vendor lock-in / cost** for the *conversational* mode (LiveKit vs ElevenLabs vs OpenAI Realtime) — prototype in P4; keep **on-device dictation as the always-available, private floor** so the product works with zero cloud voice.
- **Android on-device STT** is the weak leg (whisper.cpp is CPU-only on Android) — prefer the system `SpeechRecognizer` / ML Kit GenAI there rather than fighting Whisper.

---

## 12. Competitive positioning — the wedge

The landscape scan (mid-2026) shows a category that is **consolidating around closed incumbents while the OSS field thins**:
- **Happy** (`slopus/happy`, MIT, Expo, ~22k stars) is the OSS mobile leader — E2E-encrypted blind relay (genuinely, for message content), multi-session, cross-device resume, "voice-to-action," push. **The one to beat.** But a code-level teardown (Appendix A) confirms three structural gaps: its **voice is cloud-only (ElevenLabs over LiveKit) and breaks its own E2E** (plaintext session text + tool-call arguments go to the cloud); it has **no per-message identity/provenance** (only an unsigned free-text `sentFrom`; the richer protocol is frozen and unused); and it is **relay-dependent** (self-hosting works but is discouraged and hardwired to the vendor's cloud).
- **Omnara** (YC) validated this exact positioning (command-center, voice, push-on-approval) then **archived its OSS repo (Feb 2026)** and pivoted to a hosted voice-first service — a signal about OSS monetization difficulty *and* an opening for a credible self-hosted alternative.
- **Pure-play OSS orchestrators died in 2026** (Terragon shut down; Vibe Kanban's Bloop shut down — "mostly free users, no business model"). The survivors are desktop-only (Conductor, Sculptor) or incumbent-backed and closed: **Anthropic Claude Code Remote Control** (Feb 2026, QR-pair, Max-first), **OpenAI Codex in ChatGPT** (May 2026, push approvals, QR-pair), **GitHub Copilot via GitHub Mobile** (async issue→PR), **Cursor iOS** (June 2026, cloud dictation).

**Table stakes** (everyone has them): streaming transcript on mobile, push + one-tap approve/reject, QR/URL pairing to a local session, multi-session, diff/PR review, provider breadth. Basic voice *input* is drifting into table stakes; voice *quality* is not.

**The wedge — a combination no current competitor holds:** self-hosted + OSS + **on-device voice** + **per-message identity/provenance** (ZeroID/WIMSE) + **mobile-native conductor** ("supervise a fleet from your pocket," which the desktop orchestrators don't do on mobile). Happy owns OSS+mobile+E2E but has neither identity/provenance nor local voice; the incumbents own distribution but are closed, cloud-tied, and provenance-blind. That intersection is the defensible, world-class position.

*(Every load-bearing claim in §6/§7/§9/§12 is now backed by dated sources from the completed research pass; the earlier "truncated research" caveat no longer applies.)*

---

## Appendix A — Competitive teardown: Happy (code-verified)

Read from a local checkout of `slopus/happy` (a pnpm monorepo: `happy-app` [Expo SDK ~55 / RN 0.83 / Zustand], `happy-cli` [the `happy` binary, wraps Claude Agent SDK + Codex app-server over stdio + Gemini/ACP], `happy-server` [Fastify 5 + Prisma/Postgres, `happy-server-self-host`], `happy-agent`, `@slopus/happy-wire` [shared Zod schemas], plus an Electron IDE `codium`). MIT throughout. Claims below are verified in source, not marketing.

- **Transport / ownership:** everything connects over **Socket.IO** at `/v1/updates`; the **CLI owns the live agent + authoritative state** and pushes encrypted updates the server *persists* (Prisma) for resume/scrollback. The app is a viewer/controller. The server never runs an agent. The CLI uses the **Claude Agent SDK** (default permission mode is literally `'yolo'` in `runClaude.ts`) and a hand-rolled **Codex `app-server` JSON-RPC-over-stdio** client (`codexAppServerClient.ts`) — no PTY in the CLI (PTY lives only in the Electron `codium`).
- **Encryption (real, careful):** libsodium HMAC-SHA512 key tree → per-session/machine/artifact data keys sealed via anonymous box; **AES-256-GCM** for content, XSalsa20-Poly1305 for legacy/blobs; **Ed25519 challenge/response** auth where the account identity *is* the public key; QR pairing carries the master secret (`handy://<base64url(secret)>`). The relay is **genuinely blind to conversation content**.
- **…but NOT blind to everything:** the server sees routing metadata, the social graph, push tokens, and `UserKVStore.key` names (plaintext "for indexing"); and it **can decrypt your stored GitHub token + third-party API keys** (`GithubUser.token`, `ServiceAccountToken.token` — encrypted with the *server's* own `HANDY_MASTER_SECRET`, not E2E).
- **Voice = 100% cloud, breaks E2E (the big one):** ElevenLabs Conversational AI over LiveKit WebRTC. `contextFormatters.ts` ships agent text, user text, and **tool-call names + JSON arguments** to ElevenLabs; approvals return over the LiveKit data channel. It's also **server-gated paywalled** (20-min free tier, RevenueCat check). No on-device STT/TTS anywhere (tree-wide grep confirmed).
- **Push leaks + a privacy contradiction:** Expo Push; three triggers only (`done`/`permission`/`question`). The current path **POSTs plaintext title/body — including the working-directory folder name — to the server**, which forwards to Expo. `PRIVACY.md` claims pushes "never touch the backend"; the code contradicts it. (Presence-based suppression is a nice touch.)
- **No identity/provenance:** only an unsigned free-text `sentFrom`; the typed protocol carrying roles/turns/subagents is frozen ("not used in production, do not add consumers"). No signing, attestation, or delegation.
- **Single-user, no fleet, no cross-session memory:** one Ed25519 key = one account; a friend graph but no orgs/RBAC/tenancy; the daemon tracks N *independent* sessions with no supervisor; state is per-session with no shared long-term memory.
- **Telemetry contradiction:** README says "no tracking," app ships **PostHog** (opt-out).
- **codeoid's advantage, stated plainly:** we invert every structural gap — per-message ZeroID/WIMSE identity + delegation, **local-first voice** across web + mobile, self-hosted-first (connect to *your* daemon URL; relay only for push), the conductor/fleet supervisor, multi-tenancy, cross-session memory, and no credential-custody or telemetry gaps.

## Appendix B — Borrowed-ideas backlog (from Happy)

Happy did real engineering worth copying. Concrete, prioritized:

| Idea | What to copy | Where it lands |
| --- | --- | --- |
| **Shared wire package** | Single Zod-schema package consumed by every client, **validated at every boundary**. Validates our `@highflame/codeoid-protocol`/`@highflame/codeoid-core` extraction (§4). | P0 — and add Zod runtime validation of inbound messages (the daemon currently does `parsed as ClientMessage` with no runtime check). |
| **Session fork / rewind** | Branch a session at a precise message id (their `claudeUuid`/`codexItemId`). | Daemon feature; great mobile affordance ("rewind to here and retry"). |
| **Push discipline** | Narrow to `done`/`permission`/`question` triggers + **presence-based suppression** (skip push if a client is foregrounded). | P2 relay (§7). |
| **Layered at-rest crypto** | Key-tree → per-record sealed keys → AES-GCM; separate keys for attachments. | Only where we persist/relay blobs (push relay, any hosted sync) — our trust model needs less since the daemon is the user's. |
| **Codex app-server client** | Their stdio JSON-RPC integration (SDK lacks approval support). | Reference for codeoid's multi-provider layer. |
| **Ops maturity** | Redis-streams Socket.IO scale-out, Prometheus/pino, offline reconnect, `caffeinate`/lid-state handling so long runs don't sleep. | Daemon hardening. |
| **Monetization mechanics** | Free-tier + hard-cap + server-side subscription check (RevenueCat) gating a cloud feature. | Template for gating the hosted relay / conductor cloud (§9). |
| **One Expo codebase → 4 platforms** | iOS/Android/web + macOS (Tauri). | Validates the RN pick; macOS-via-Tauri is a bonus target. |
