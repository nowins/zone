import { useCallback, useEffect, useState } from "react";
import type { LyricsProviderConfig } from "../types";
import { LYRICS_PROVIDERS } from "../lyrics/providers";

const PROVIDER_SETTINGS_KEY = "zone-lyrics-providers-v1";
const PROVIDER_SETTINGS_EVENT = "zone-lyrics-provider-settings";

export function useLyricsProviderSettings() {
  const [configs, setConfigs] = useState<LyricsProviderConfig[]>(readLyricsProviderSettings);

  useEffect(() => {
    const sync = () => setConfigs(readLyricsProviderSettings());
    window.addEventListener(PROVIDER_SETTINGS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(PROVIDER_SETTINGS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const update = useCallback((recipe: (current: LyricsProviderConfig[]) => LyricsProviderConfig[]) => {
    const next = normalizeConfigs(recipe(readLyricsProviderSettings()));
    localStorage.setItem(PROVIDER_SETTINGS_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(PROVIDER_SETTINGS_EVENT));
    setConfigs(next);
  }, []);

  const setEnabled = useCallback((id: string, enabled: boolean) => {
    update((current) => current.map((config) => config.id === id ? { ...config, enabled } : config));
  }, [update]);

  const move = useCallback((id: string, direction: -1 | 1) => {
    update((current) => {
      const ordered = [...current].sort((left, right) => left.priority - right.priority);
      const index = ordered.findIndex((config) => config.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= ordered.length) return current;
      [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
      return ordered.map((config, priority) => ({ ...config, priority: (priority + 1) * 10 }));
    });
  }, [update]);

  return { configs, providers: LYRICS_PROVIDERS, setEnabled, move };
}

export function readLyricsProviderSettings() {
  try {
    const raw = localStorage.getItem(PROVIDER_SETTINGS_KEY);
    if (!raw) return defaultConfigs();
    const parsed = JSON.parse(raw) as unknown;
    return normalizeConfigs(Array.isArray(parsed) ? parsed as LyricsProviderConfig[] : []);
  } catch {
    return defaultConfigs();
  }
}

function defaultConfigs(): LyricsProviderConfig[] {
  return LYRICS_PROVIDERS.map((provider) => ({
    id: provider.id,
    enabled: provider.defaultEnabled,
    priority: provider.defaultPriority,
    timeoutMs: provider.defaultTimeoutMs,
  }));
}

function normalizeConfigs(configs: LyricsProviderConfig[]) {
  const stored = new Map(configs.map((config) => [config.id, config]));
  return LYRICS_PROVIDERS.map((provider) => {
    const config = stored.get(provider.id);
    return {
      id: provider.id,
      enabled: typeof config?.enabled === "boolean" ? config.enabled : provider.defaultEnabled,
      priority: finite(config?.priority) ? config!.priority : provider.defaultPriority,
      timeoutMs: finite(config?.timeoutMs)
        ? Math.min(20_000, Math.max(provider.defaultTimeoutMs, config!.timeoutMs))
        : provider.defaultTimeoutMs,
    };
  }).sort((left, right) => left.priority - right.priority);
}

function finite(value?: number): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
