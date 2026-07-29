/**
 * Re-export shim — approval scanning lives in `@highflame/codeoid-core` so every
 * frontend surfaces the same pending-approval semantics.
 */
export { findPendingApproval } from "@highflame/codeoid-core";
