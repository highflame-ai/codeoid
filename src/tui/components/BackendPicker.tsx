import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ProviderInfo } from "../../protocol/types.js";
import type { TuiWsClient } from "../ws.js";

export interface BackendChoice {
  value: string;
  label: string;
  description?: string;
}

interface Props {
  kind: "model" | "provider" | "account";
  provider: string;
  current: string;
  providers: ProviderInfo[];
  client: TuiWsClient | null;
  onPick: (value: string) => Promise<void>;
  onCancel: () => void;
}

export function BackendPicker({ kind, provider, current, providers, client, onPick, onCancel }: Props) {
  const [choices, setChoices] = useState<BackendChoice[]>([]);
  const [loading, setLoading] = useState(kind !== "provider");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState(current);
  const submitting = useRef(false);

  useEffect(() => {
    if (kind === "provider") return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const load = async () => {
      if (!client) throw new Error("Not connected");
      if (kind === "model") {
        const result = await client.listModels(provider);
        if (cancelled) return;
        setChoices(result.models.map((model) => ({
          value: model.value,
          label: model.displayName,
          description: [model.value, model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k context` : "", model.description].filter(Boolean).join(" · "),
        })));
        setLive(result.live);
      } else {
        const result = await client.listClaudeAccounts();
        if (cancelled) return;
        setChoices([
          { value: "", label: `Follow daemon default (${result.defaultAccount})` },
          { value: "default", label: "default — this machine's Claude login" },
          ...result.accounts.filter((account) => account.name !== "default").map((account) => ({
            value: account.name, label: account.name, description: account.kind,
          })),
        ]);
      }
    };
    void load().catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [client, kind, provider, revision]);

  const options = kind === "provider"
    ? providers.map((entry) => ({ value: entry.id, label: entry.displayName, description: entry.id }))
    : choices;
  const index = Math.max(0, options.findIndex((choice) => choice.value === selected));
  const start = Math.max(0, Math.min(index - 3, options.length - 8));

  useInput((input, key) => {
    if (submitting.current) return;
    if (key.escape) { onCancel(); return; }
    if (input === "r" && !loading) { setRevision((value) => value + 1); return; }
    if (loading) return;
    if (key.upArrow || key.downArrow) {
      const next = Math.max(0, Math.min(options.length - 1, index + (key.upArrow ? -1 : 1)));
      if (options[next]) setSelected(options[next].value);
    }
    if (key.return && options[index]) {
      submitting.current = true;
      setBusy(true);
      setError(null);
      void onPick(options[index].value).then(onCancel).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      }).finally(() => { submitting.current = false; setBusy(false); });
    }
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Select {kind}{kind === "model" ? ` (${provider})` : ""}</Text>
      {loading ? <Text dimColor>Loading…</Text> : options.slice(start, start + 8).map((choice, offset) => (
        <Box key={choice.value} flexDirection="column">
          <Text color={start + offset === index ? "cyan" : undefined}>
            {start + offset === index ? "▸ " : "  "}{choice.label}{choice.value === current ? " ●" : ""}
          </Text>
          {choice.description && <Text dimColor wrap="truncate-end">  {choice.description}</Text>}
        </Box>
      ))}
      {!loading && options.length === 0 && <Text dimColor>No choices available.{kind === "model" ? " Use /model <id> to enter a model directly." : ""}</Text>}
      {!loading && kind === "model" && !live && <Text dimColor>Cached catalog — press r to refresh.</Text>}
      {error && <Text color="red">{error}</Text>}
      <Text dimColor>{busy ? "Switching…" : "↑↓ navigate · Enter to select · r refresh · Esc cancel"}</Text>
    </Box>
  );
}
