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
  /** Name of the session this picker changes, shown in the header. */
  sessionName?: string;
  current: string;
  providers: ProviderInfo[];
  client: TuiWsClient | null;
  onPick: (value: string) => Promise<void>;
  onCancel: () => void;
}

export function BackendPicker({ kind, provider, sessionName, current, providers, client, onPick, onCancel }: Props) {
  const [choices, setChoices] = useState<BackendChoice[]>([]);
  const [loading, setLoading] = useState(kind !== "provider");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState(current);
  const submitting = useRef(false);
  // Esc closes the picker even mid-switch; the switch's late result must not
  // touch state or close whatever dialog has opened since.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

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
    if (key.escape) { onCancel(); return; }
    if (submitting.current) return;
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
      void onPick(options[index].value).then(() => {
        if (mounted.current) onCancel();
      }, (cause: unknown) => {
        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      }).finally(() => {
        submitting.current = false;
        if (mounted.current) setBusy(false);
      });
    }
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Select {kind}{kind === "model" ? ` (${provider})` : ""}{sessionName ? ` for ${sessionName}` : ""}</Text>
      {loading ? <Text dimColor>Loading…</Text> : options.slice(start, start + 8).map((choice, offset) => (
        // A server may list an id twice: the position keeps keys unique.
        <Box key={`${start + offset}:${choice.value}`} flexDirection="column">
          <Text color={start + offset === index ? "cyan" : undefined}>
            {start + offset === index ? "▸ " : "  "}{choice.label}{choice.value === current ? " ●" : ""}
          </Text>
          {choice.description && <Text dimColor wrap="truncate-end">  {choice.description}</Text>}
        </Box>
      ))}
      {!loading && options.length === 0 && <Text dimColor>No choices available.{kind === "model" ? " Use /model <id> to enter a model directly." : ""}</Text>}
      {/* Only an endpoint can be asked for its live list on demand; a
          built-in backend reports its full catalog from inside a turn. */}
      {!loading && kind === "model" && !live && <Text dimColor>{provider.startsWith("oai:")
        // An endpoint's list is live unless its /models just failed.
        ? "Couldn't reach the endpoint's /models — showing configured models; press r to retry."
        : "Saved catalog — the current list appears after this backend's next turn."}</Text>}
      {error && <Text color="red">{error}</Text>}
      <Text dimColor>{busy ? "Switching… (Esc hides this; the switch still applies)" : "↑↓ navigate · Enter to select · r refresh · Esc cancel"}</Text>
    </Box>
  );
}
