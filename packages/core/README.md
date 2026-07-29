# @highflame/codeoid-core

Framework-agnostic client core for the [Codeoid](https://github.com/highflame-ai/codeoid)
daemon — everything a frontend needs except the pixels:

- **`CodeoidClient`** — the WebSocket transport: auth handshake (token +
  protocol version + capability declaration), request/response correlation,
  liveness heartbeat, exponential-backoff reconnect with full jitter. Needs
  only a WHATWG `WebSocket` global (browsers, React Native, Bun, Node ≥ 22).
  All timing is injectable. Native hosts call `reconnectNow()` from their own
  resume signal (e.g. React Native `AppState`).
- **`MessageStore`** + kernels (`mergeDeltaInto`, `dedupeReplay`) — the
  single source of truth for transcript accumulation: upsert-by-messageId,
  streaming delta merges, snapshot vs chunked vs incremental replay routing
  (`ingest()`), per-message versions and per-session epochs.
- **`ResumeCursors`** — `replay.resume` cursor tracking so reconnects fetch
  only the tail mutated since, not the whole scrollback.
- Display helpers shared across frontends: usage formatters (`formatTokens`,
  `formatCostUsd`, …), identity/provenance labels (`shortSub`,
  `identityLabel`, …), approval scanning, slash-command parsing.

```ts
import { CodeoidClient, MessageStore, ResumeCursors } from "@highflame/codeoid-core";
import { CAPABILITIES } from "@highflame/codeoid-protocol";

const store = new MessageStore();
const cursors = new ResumeCursors();
const client = new CodeoidClient({
  url: "ws://localhost:7400",
  token,
  capabilities: [CAPABILITIES.PARTS, CAPABILITIES.CHUNKED_REPLAY, CAPABILITIES.SEQ_RESUME],
  clientName: "my-frontend/1.0",
});
client.onMessage((msg) => store.ingest(msg, cursors));
await client.connect();
```

Ships TypeScript source (every consumer transpiles TS — Bun, Vite, Metro).
`@highflame/codeoid-protocol` is a peer dependency.
