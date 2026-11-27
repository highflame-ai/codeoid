/**
 * Account choices for one backend, as the TUI's pickers list them
 * (docs/backend-accounts-design.md).
 *
 * "" follows the backend's daemon default (sent as `null`); the literal
 * "default" pins the built-in account — the daemon's own login or
 * environment; any other value pins that named account.
 */

import { DEFAULT_ACCOUNT } from "../protocol/types.js";
import type { BackendAccountsInfo } from "../protocol/types.js";
import type { BackendChoice } from "./components/BackendPicker.js";

export function accountChoices(info: BackendAccountsInfo): BackendChoice[] {
  const kindLabel = new Map(info.kinds.map((kind) => [kind.kind, kind.label]));
  return [
    { value: "", label: `Follow daemon default (${info.defaultAccount})` },
    { value: DEFAULT_ACCOUNT, label: `${DEFAULT_ACCOUNT} — the daemon's own ${info.displayName} login or key` },
    ...info.accounts.filter((account) => account.name !== DEFAULT_ACCOUNT).map((account) => ({
      value: account.name,
      label: account.name,
      description: [
        kindLabel.get(account.kind) ?? account.kind,
        account.baseUrl,
        account.headerNames?.length ? `headers: ${account.headerNames.join(", ")}` : "",
        account.envNames?.length ? account.envNames.join(", ") : "",
      ].filter(Boolean).join(" · "),
    })),
  ];
}
