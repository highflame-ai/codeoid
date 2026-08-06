# @highflame/codeoid-protocol

The Codeoid client↔daemon wire protocol: the message/event types
(`ClientMessage`, `DaemonMessage`, `SessionMessage`, deltas, `SessionInfo`, …),
the `PROTOCOL_VERSION` constant, and the permission `SCOPES`.

Single source of truth shared by the daemon, the web UI, and the mobile client
— import these from `@highflame/codeoid-protocol` instead of copying them.

```ts
import type { ClientMessage, DaemonMessage } from "@highflame/codeoid-protocol";
import { PROTOCOL_VERSION, SCOPES } from "@highflame/codeoid-protocol";
```

Ships TypeScript source: every consumer (Bun, Vite, Metro) transpiles TS, so no
build step is required. Forward-compatibility rule for the wire format: additive
changes only, and ignore unknown message/part kinds and fields.
