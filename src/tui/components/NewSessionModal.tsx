import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { ProviderInfo } from "../../protocol/types.js";
import type { TuiWsClient } from "../ws.js";
import type { BackendChoice } from "./BackendPicker.js";

export interface NewSessionOptions {
  providerId?: string;
  claudeAccount?: string;
}

interface Props {
  providers: ProviderInfo[];
  client: TuiWsClient | null;
  onSubmit: (name: string, workdir: string, options: NewSessionOptions) => Promise<void>;
  onCancel: () => void;
}

export function NewSessionModal({ providers, client, onSubmit, onCancel }: Props) {
  const [focused, setFocused] = useState("name");
  const [name, setName] = useState("");
  const [workdir, setWorkdir] = useState(process.cwd());
  const [providerId, setProviderId] = useState("");
  const [account, setAccount] = useState("");
  const [accounts, setAccounts] = useState<BackendChoice[]>([{ value: "", label: "Follow daemon default" }]);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const effectiveProvider = providerId || providers[0]?.id || "claude";
  const fields = ["name", "workdir", "provider", ...(effectiveProvider === "claude" ? ["account"] : [])];
  const providerChoices = [
    { value: "", label: `Daemon default (${providers[0]?.displayName ?? "claude"})` },
    ...providers.map((provider) => ({ value: provider.id, label: `${provider.displayName} (${provider.id})` })),
  ];

  useEffect(() => {
    if (effectiveProvider !== "claude" || !client) return;
    let cancelled = false;
    setAccountError(null);
    void client.listClaudeAccounts().then((result) => {
      if (cancelled) return;
      setAccounts([
        { value: "", label: `Follow daemon default (${result.defaultAccount})` },
        { value: "default", label: "default — this machine's Claude login" },
        ...result.accounts.filter((entry) => entry.name !== "default").map((entry) => ({ value: entry.name, label: entry.name })),
      ]);
    }).catch((cause: unknown) => {
      if (!cancelled) setAccountError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [client, effectiveProvider]);

  useEffect(() => {
    if (focused === "account" && effectiveProvider !== "claude") setFocused("provider");
  }, [focused, effectiveProvider]);

  const submit = async () => {
    if (submitting.current || !name.trim() || !workdir.trim()) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim(), workdir.trim(), {
        ...(providerId ? { providerId } : {}),
        ...(effectiveProvider === "claude" && account ? { claudeAccount: account } : {}),
      });
      onCancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  useInput((_input, key) => {
    if (submitting.current) return;
    if (key.escape) { onCancel(); return; }
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
        <TextInput focus={!busy && focused === "name"} value={name} onChange={setName} onSubmit={() => { if (name.trim()) setFocused("workdir"); }} />
      </Box>
      <Box>
        <Text color={focused === "workdir" ? "cyan" : undefined}>{focused === "workdir" ? "▸ " : "  "}workdir: </Text>
        <TextInput focus={!busy && focused === "workdir"} value={workdir} onChange={setWorkdir} onSubmit={() => { void submit(); }} />
      </Box>
      <Text color={focused === "provider" ? "cyan" : undefined}>
        {focused === "provider" ? "▸ " : "  "}provider: {providerChoices.find((choice) => choice.value === providerId)?.label ?? `${providerId} (removed)`}
      </Text>
      {effectiveProvider === "claude" && <Text color={focused === "account" ? "cyan" : undefined}>
        {focused === "account" ? "▸ " : "  "}account: {accounts.find((choice) => choice.value === account)?.label ?? `${account} (missing)`}
      </Text>}
      {effectiveProvider === "claude" && accountError && <Text color="yellow">Account choices unavailable: {accountError}</Text>}
      {error && <Text color="red">{error}</Text>}
      <Text dimColor>{busy ? "Creating…" : "Tab switches fields · ←→ chooses provider/account · Enter creates · Esc cancels"}</Text>
    </Box>
  );
}
