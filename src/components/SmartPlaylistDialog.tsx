import { useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import {
  defaultSmartPlaylistConfig,
  describeSmartPlaylist,
  evaluateSmartPlaylist,
  smartPlaylistPresets,
  smartRule,
} from "../utils/smartPlaylist";
import type {
  SmartPlaylist,
  SmartPlaylistConfig,
  SmartRule,
  SmartRuleField,
  SmartRuleOperator,
  Track,
  TrackActivityMap,
} from "../types";

export type SmartPlaylistDraft = {
  name: string;
  description: string;
  smart: SmartPlaylistConfig;
  excludedTrackIds: string[];
};

const FIELD_OPTIONS: { value: SmartRuleField; label: string }[] = [
  { value: "artist", label: "艺术家" },
  { value: "album", label: "专辑" },
  { value: "genre", label: "风格" },
  { value: "year", label: "年代" },
  { value: "favorite", label: "收藏状态" },
  { value: "playCount", label: "播放次数" },
  { value: "lastPlayed", label: "最近播放" },
  { value: "dateAdded", label: "加入时间" },
  { value: "skipRate", label: "跳过率" },
];

export function SmartPlaylistDialog({
  playlist,
  tracks,
  favoriteTrackIds,
  activity,
  onCancel,
  onSave,
}: {
  playlist?: SmartPlaylist;
  tracks: Track[];
  favoriteTrackIds: ReadonlySet<string>;
  activity: TrackActivityMap;
  onCancel: () => void;
  onSave: (draft: SmartPlaylistDraft) => void;
}) {
  const presets = useMemo(smartPlaylistPresets, []);
  const firstPreset = presets[0];
  const [name, setName] = useState(playlist?.name ?? firstPreset.name);
  const [config, setConfig] = useState<SmartPlaylistConfig>(() =>
    playlist?.smart ?? structuredClone(firstPreset.config),
  );
  const [excludedTrackIds, setExcludedTrackIds] = useState(playlist?.excludedTrackIds ?? []);
  const [activePresetId, setActivePresetId] = useState(playlist ? "custom" : firstPreset.id);
  const result = useMemo(
    () => evaluateSmartPlaylist(config, tracks, { favoriteTrackIds, activity }, new Set(excludedTrackIds)),
    [activity, config, excludedTrackIds, favoriteTrackIds, tracks],
  );
  const ruleDescription = describeSmartPlaylist(config);
  const suggestions = useMemo(() => ({
    artist: uniqueSorted(tracks.flatMap((track) => [track.artist, track.album_artist ?? ""])),
    album: uniqueSorted(tracks.map((track) => track.album)),
    genre: uniqueSorted(tracks.flatMap((track) => track.genres ?? [])),
  }), [tracks]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  function applyPreset(presetId: string) {
    const preset = presets.find((item) => item.id === presetId);
    if (!preset) return;
    setActivePresetId(preset.id);
    setName(preset.name);
    setConfig(structuredClone(preset.config));
  }

  function updateConfig(patch: Partial<SmartPlaylistConfig>) {
    setActivePresetId("custom");
    setConfig((current) => ({ ...current, ...patch }));
  }

  function updateRule(ruleId: string, patch: Partial<SmartRule>) {
    updateConfig({
      rules: config.rules.map((rule) => rule.id === ruleId ? { ...rule, ...patch } : rule),
    });
  }

  function changeRuleField(ruleId: string, field: SmartRuleField) {
    const replacement = defaultRuleForField(field);
    updateRule(ruleId, { ...replacement, id: ruleId });
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) return;
    onSave({
      name: cleanName,
      description: ruleDescription,
      smart: config,
      excludedTrackIds,
    });
  }

  return (
    <div
      className="smart-playlist-overlay"
      role="presentation"
    >
      <form
        className="smart-playlist-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="smart-playlist-title"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="smart-editor-header">
          <div>
            <span className="playlist-dialog-kicker">智能播放列表</span>
            <h2 id="smart-playlist-title">{playlist ? "编辑规则" : "想听什么？"}</h2>
            <p>{ruleDescription}</p>
          </div>
          <label className="smart-name-field">
            <span>名称</span>
            <input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </label>
        </header>

        <div className="smart-editor-layout">
          <aside className="smart-presets" aria-label="智能播放列表模板">
            <span>从一个方案开始</span>
            {presets.map((preset) => (
              <button
                type="button"
                key={preset.id}
                className={activePresetId === preset.id ? "selected" : ""}
                onClick={() => applyPreset(preset.id)}
              >
                <strong>{preset.name}</strong>
                <small>{preset.description}</small>
              </button>
            ))}
          </aside>

          <section className="smart-rules-panel">
            <div className="smart-section-heading">
              <div>
                <span>选歌条件</span>
                <strong>匹配{config.match === "all" ? "全部" : "任意"}规则</strong>
              </div>
              <div className="smart-segmented" aria-label="规则匹配方式">
                <button type="button" className={config.match === "all" ? "selected" : ""} onClick={() => updateConfig({ match: "all" })}>全部</button>
                <button type="button" className={config.match === "any" ? "selected" : ""} onClick={() => updateConfig({ match: "any" })}>任意</button>
              </div>
            </div>

            <div className="smart-rule-list">
              {config.rules.length === 0 && (
                <p className="smart-rule-empty">没有限制，将从整个音乐库中生成混合。</p>
              )}
              {config.rules.map((rule) => (
                <div className="smart-rule-row" key={rule.id}>
                  <select value={rule.field} aria-label="规则字段" onChange={(event) => changeRuleField(rule.id, event.target.value as SmartRuleField)}>
                    {FIELD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <select value={rule.operator} aria-label="规则关系" onChange={(event) => updateRule(rule.id, { operator: event.target.value as SmartRuleOperator })}>
                    {operatorOptions(rule.field).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <RuleValueEditor rule={rule} suggestions={suggestions} onChange={(patch) => updateRule(rule.id, patch)} />
                  <button type="button" className="smart-rule-remove" title="移除规则" onClick={() => updateConfig({ rules: config.rules.filter((item) => item.id !== rule.id) })}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="smart-add-rule"
              onClick={() => updateConfig({ rules: [...config.rules, smartRule("genre", "contains", "")] })}
            >
              <Plus size={15} /> 添加条件
            </button>

            <div className="smart-mix-settings">
              <label>
                <span>排列</span>
                <select value={config.order} onChange={(event) => updateConfig({ order: event.target.value as SmartPlaylistConfig["order"] })}>
                  <option value="smart">智能混合</option>
                  <option value="leastPlayed">最少播放优先</option>
                  <option value="oldestPlayed">最久未听优先</option>
                  <option value="recentlyAdded">最近加入优先</option>
                  <option value="title">按歌曲标题</option>
                </select>
              </label>
              <label>
                <span>长度</span>
                <div className="smart-inline-fields">
                  <input type="number" min="1" max="999" value={config.limitValue} onChange={(event) => updateConfig({ limitValue: safePositive(event.target.value, 1) })} />
                  <select value={config.limitKind} onChange={(event) => updateConfig({ limitKind: event.target.value as SmartPlaylistConfig["limitKind"] })}>
                    <option value="tracks">首</option>
                    <option value="minutes">分钟</option>
                  </select>
                </div>
              </label>
              <label>
                <span>每位艺术家</span>
                <div className="smart-inline-fields">
                  <input type="number" min="0" max="99" value={config.maxPerArtist} onChange={(event) => updateConfig({ maxPerArtist: safeNonNegative(event.target.value) })} />
                  <small>0 不限制</small>
                </div>
              </label>
              <label>
                <span>每张专辑</span>
                <div className="smart-inline-fields">
                  <input type="number" min="0" max="99" value={config.maxPerAlbum} onChange={(event) => updateConfig({ maxPerAlbum: safeNonNegative(event.target.value) })} />
                  <small>0 不限制</small>
                </div>
              </label>
            </div>

            <div className="smart-switches">
              <Toggle checked={config.preferFavorites} label="偏爱收藏" onChange={(preferFavorites) => updateConfig({ preferFavorites })} />
              <Toggle checked={config.avoidSkipped} label="避开常跳过歌曲" onChange={(avoidSkipped) => updateConfig({ avoidSkipped })} />
              <Toggle checked={config.rotateDaily} label="每天轮换" onChange={(rotateDaily) => updateConfig({ rotateDaily })} />
            </div>
          </section>

          <aside className="smart-preview">
            <div className="smart-preview-heading">
              <div>
                <span>即时预览</span>
                <strong>{result.tracks.length} 首</strong>
              </div>
              <button type="button" title="换一批" onClick={() => updateConfig({ rotationSeed: config.rotationSeed + 1 })}>
                <RefreshCw size={16} />
              </button>
            </div>
            <p>{formatMinutes(result.durationSeconds)} · 从 {result.matchedCount} 首匹配歌曲中生成</p>
            {result.missingMetadataCount > 0 && <small>{result.missingMetadataCount} 首缺少相关标签，未参与部分筛选</small>}
            <div className="smart-preview-tracks">
              {result.tracks.length === 0 ? (
                <div className="smart-preview-empty">
                  <Sparkles size={22} />
                  <strong>暂时没有匹配</strong>
                  <span>可以减少条件，或切换为“任意”规则。</span>
                </div>
              ) : result.tracks.slice(0, 9).map((track, index) => (
                <div key={track.id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <p><strong>{track.title}</strong><small>{track.artist}</small></p>
                </div>
              ))}
            </div>
            {excludedTrackIds.length > 0 && (
              <button type="button" className="smart-restore-exclusions" onClick={() => setExcludedTrackIds([])}>
                恢复 {excludedTrackIds.length} 首已排除歌曲
              </button>
            )}
          </aside>
        </div>

        <footer className="smart-editor-footer">
          <span>列表会随音乐库和收听习惯自动更新；开始播放后，当前队列保持不变。</span>
          <div>
            <button type="button" onClick={onCancel}>取消</button>
            <button type="submit" className="primary" disabled={!name.trim()}>保存智能列表</button>
          </div>
        </footer>
      </form>
    </div>
  );
}

function RuleValueEditor({
  rule,
  suggestions,
  onChange,
}: {
  rule: SmartRule;
  suggestions: Record<"artist" | "album" | "genre", string[]>;
  onChange: (patch: Partial<SmartRule>) => void;
}) {
  if (rule.operator === "never") return <span className="smart-rule-static">无需输入</span>;
  if (rule.field === "favorite") {
    return (
      <select value={String(Boolean(rule.value))} aria-label="收藏状态" onChange={(event) => onChange({ value: event.target.value === "true" })}>
        <option value="true">已收藏</option>
        <option value="false">未收藏</option>
      </select>
    );
  }
  if (rule.field === "artist" || rule.field === "album" || rule.field === "genre") {
    return (
      <div className="smart-rule-value">
        <input list={`smart-${rule.field}-${rule.id}-values`} value={String(rule.value ?? "")} placeholder={`输入${fieldName(rule.field)}`} onChange={(event) => onChange({ value: event.target.value })} />
        <datalist id={`smart-${rule.field}-${rule.id}-values`}>
          {suggestions[rule.field].map((value) => <option key={value} value={value} />)}
        </datalist>
      </div>
    );
  }
  if (rule.operator === "between") {
    return (
      <div className="smart-range-value">
        <input type="number" value={Number(rule.value ?? 1990)} onChange={(event) => onChange({ value: Number(event.target.value) })} />
        <span>到</span>
        <input type="number" value={rule.valueTo ?? 1999} onChange={(event) => onChange({ valueTo: Number(event.target.value) })} />
      </div>
    );
  }
  return (
    <div className="smart-rule-number">
      <input type="number" min="0" value={Number(rule.value ?? 0)} onChange={(event) => onChange({ value: Number(event.target.value) })} />
      {(rule.field === "lastPlayed" || rule.field === "dateAdded") && <span>天</span>}
      {rule.field === "skipRate" && <span>%</span>}
    </div>
  );
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <label className="smart-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span aria-hidden="true" />
      <strong>{label}</strong>
    </label>
  );
}

function defaultRuleForField(field: SmartRuleField): Omit<SmartRule, "id"> {
  if (field === "favorite") return { field, operator: "is", value: true };
  if (field === "lastPlayed") return { field, operator: "olderThanDays", value: 30 };
  if (field === "dateAdded") return { field, operator: "withinDays", value: 30 };
  if (field === "year") return { field, operator: "between", value: 1990, valueTo: 1999 };
  if (field === "playCount") return { field, operator: "atMost", value: 3 };
  if (field === "skipRate") return { field, operator: "atMost", value: 30 };
  return { field, operator: "contains", value: "" };
}

function operatorOptions(field: SmartRuleField): { value: SmartRuleOperator; label: string }[] {
  if (field === "artist" || field === "album" || field === "genre") return [
    { value: "contains", label: "包含" },
    { value: "equals", label: "是" },
    { value: "notContains", label: "不包含" },
  ];
  if (field === "year") return [
    { value: "between", label: "介于" },
    { value: "equals", label: "是" },
    { value: "atLeast", label: "不早于" },
    { value: "atMost", label: "不晚于" },
  ];
  if (field === "favorite") return [{ value: "is", label: "是" }];
  if (field === "lastPlayed") return [
    { value: "never", label: "从未播放" },
    { value: "olderThanDays", label: "超过" },
    { value: "withinDays", label: "最近" },
  ];
  if (field === "dateAdded") return [
    { value: "withinDays", label: "最近" },
    { value: "olderThanDays", label: "早于" },
  ];
  return [
    { value: "equals", label: "等于" },
    { value: "atLeast", label: "不少于" },
    { value: "atMost", label: "不多于" },
  ];
}

function fieldName(field: "artist" | "album" | "genre") {
  return { artist: "艺术家", album: "专辑", genre: "风格" }[field];
}

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function safePositive(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeNonNegative(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatMinutes(seconds: number) {
  if (!seconds) return "时长未知";
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `约 ${minutes} 分钟`;
}
