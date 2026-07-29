/**
 * Re-export shim — the transport now lives in `@highflame/codeoid-core` (the same
 * `CodeoidClient` the mobile app uses; web passes its capabilities at the
 * construction site in state/connection.ts). Kept so existing "../lib/ws"
 * imports resolve unchanged; new code may import from `@highflame/codeoid-core`.
 */
export { CodeoidClient } from "@highflame/codeoid-core";
export type { ClientStatus, ConnectOptions } from "@highflame/codeoid-core";
