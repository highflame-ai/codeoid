import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { backendHasAccounts } from "../../protocol/types.js";
import type { ProviderInfo } from "../../protocol/types.js";
import type { TuiWsClient } from "../ws.js";
import { accountChoices } from "../accounts.js";
import type { BackendChoice } from "./BackendPicker.js";

export interface NewSessionOptions {
  providerId?: string;
  /** The account for the backend the session lands on; absent = follow its default. */
  account?: string;
}

interface Props {
  providers: ProviderInfo[];
  client: TuiWsClient | null;
  onSubmit: (name: string, workdir: string, options: NewSessionOptions) => Promise<void>;
  onCancel: () => void;
}

const FOLLOW_ONLY: BackendChoice[] = [{ value: "", label: "Follow daemon default" }];

export function NewSessionModal({ providers, client, onSubmit, onCancel }: Props) {
  const [focused, setFocused] = useState("name");
  const [name, setName] = useState("");
  const [workdir, setWorkdir] = useState(process.cwd());
  const [providerId, setProviderId] = useState("");
  const [account, setAccount] = useState("");
  const [accounts, setAccounts] = useState<BackendChoice[]>(FOLLOW_ONLY);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  // Esc closes the dialog even while a create is in flight; its late result
  // must not touch state or close whatever dialog has opened since.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const effectiveProvider = providerId || providers[0]?.id || "claude";
  const hasAccounts = backendHasAccounts(effectiveProvider);
  const fields = ["name", "workdir", "provider", ...(hasAccounts ? ["account"] : [])];
  const providerChoices = [
    { value: "", label: `Daemon default (${providers[0]?.displayName ?? "claude"})` },
    ...providers.map((provider) => ({ value: provider.id, label: `${provider.displayName} (${provider.id})` })),
  ];

  // Accounts belong to one backend: a different provider starts from its own
  // list and its own default, never a name chosen for the previous one.
  useEffect(() => {
    setAccount("");
    setAccounts(FOLLOW_ONLY);
    setAccountError(null);
    if (!hasAccounts || !client) return;
    let cancelled = false;
    void client.listAccounts(effectiveProvider).then((result) => {
      if (!cancelled) setAccounts(accountChoices(result));
    }).catch((cause: unknown) => {
      if (!cancelled) setAccountError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [client, effectiveProvider, hasAccounts]);

  useEffect(() => {
    if (focused === "account" && !hasAccounts) setFocused("provider");
  }, [focused, hasAccounts]);

  const submit = async () => {
    if (submitting.current) return;
    const missing = !name.trim() ? "name" : !workdir.trim() ? "workdir" : null;
    if (missing) {
      setError(missing === "name" ? "Name required" : "Workdir required");
      setFocused(missing);
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim(), workdir.trim(), {
        ...(providerId ? { providerId } : {}),
        ...(hasAccounts && account ? { account } : {}),
      });
      if (mounted.current) onCancel();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  useInput((_input, key) => {
    if (key.escape) { onCancel(); return; }
    if (submitting.current) return;
    if (key.tab) {
      setFocused(fields[(fields.indexOf(focused) + (key.shift ? fields.length - 1 : 1)) % fields.length]!);
      return;
    }
    if (focused !== "provider" && focused !== "account") return;
    const choices = focused === "provider" ? providerChoices : accounts;
    const value = focused === "provider" ? providerId : account;
    const select = focused === "provider" ? setProviderId : setAccount;
    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      const direction = key.leftArrow || key.upArrow ? -1 : 1;
      const index = Math.max(0, choices.findIndex((choice) => choice.value === value));
      select(choices[(index + direction + choices.length) % choices.length]!.value);
    }
    if (key.return) void submit();
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">New Session</Text>
      <Box>
        <Text color={focused === "name" ? "cyan" : undefined}>{focused === "name" ? "▸ " : "  "}name: </Text>
        <TextInput focus={!busy && focused === "name"} value={name} onChange={(value) => { setName(value); if (error === "Name required") setError(null); }} onSubmit={() => { if (name.trim()) setFocused("workdir"); else setError("Name required"); }} />
      </Box>
      <Box>
        <Text color={focused === "workdir" ? "cyan" : undefined}>{focused === "workdir" ? "▸ " : "  "}workdir: </Text>
        <TextInput focus={!busy && focused === "workdir"} value={workdir} onChange={setWorkdir} onSubmit={() => { void submit(); }} />
      </Box>
      <Text color={focused === "provider" ? "cyan" : undefined}>
        {focused === "provider" ? "▸ " : "  "}provider: {providerChoices.find((choice) => choice.value === providerId)?.label ?? `${providerId} (removed)`}
      </Text>
      {hasAccounts && <Text color={focused === "account" ? "cyan" : undefined}>
        {focused === "account" ? "▸ " : "  "}account: {accounts.find((choice) => choice.value === account)?.label ?? `${account} (missing)`}
      </Text>}
      {hasAccounts && accountError && <Text color="yellow">Account choices unavailable: {accountError}</Text>}
      {error && <Text color="red">{error}</Text>}
      <Text dimColor>{busy ? "Creating… (Esc hides this; the session is still created)" : "Tab switches fields · ←→ chooses provider/account · Enter creates · Esc cancels"}</Text>
    </Box>
  );
}
