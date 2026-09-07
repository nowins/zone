import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { ArrowDownLeft, Disc3, ListMusic, Music2, Palette, Pin, PinOff, Podcast, Sparkles, UserRound } from "lucide-react";
import { createPortal } from "react-dom";
import { Cover } from "../Cover";
import { Button } from "../Button";
import { Dialog } from "../Dialog";
import { animateValue, type AnimationHandle } from "../../motion/animate";
import { Presence, useLastNonNull } from "../../motion/presence";
import { MOTION_DURATIONS, TILE_MOTION } from "../../motion/tokens";
import { MOTION_TWEENS } from "../../motion/tween";
import { useReducedMotion } from "../../motion/useReducedMotion";
import { HOME_PIN_SIZES, HOME_PIN_TONES, moveHomePin, nextHomePinSize, stepHomePinSize } from "../../utils/homePins";
import { FlipTile } from "./FlipTile";
import { MosaicFrames } from "./MosaicTile";
import { usePinDrag } from "./usePinDrag";
import type { ContextPayload, HomePin, HomePinCustomization, HomePinSize, HomePinTone, PodcastFeed, Track } from "../../types";

export type ResolvedPin = {
  pin: HomePin;
  title: string;
  subtitle: string;
  tracks: Track[];
  artPaths: string[];
  payload: ContextPayload | null;
  size: HomePinSize;
  isSmart: boolean;
  liveLine: string;
  podcastFeed?: PodcastFeed;
  podcastArtwork?: string | null;
  podcastRecency?: string;
};

const SIZE_LABELS: Record<HomePinSize, string> = { small: "小", medium: "中", wide: "宽", large: "大" };
const KIND_LABELS = { track: "歌曲", album: "专辑", artist: "艺术家", playlist: "播放列表", podcastFeed: "播客节目" };
const KIND_ICONS = { track: Music2, album: Disc3, artist: UserRound, playlist: ListMusic, podcastFeed: Podcast };
type Placement = { target: string; after: boolean };

export function QuickplayPinBoard({ items, onOpenCollection, onMovePin, onShiftPin, onResizePin, onCustomizePin, onUnpin, onActivate, onContextMenu }: {
  items: ResolvedPin[];
  onOpenCollection: () => void;
  onMovePin: (source: string, target: string, after?: boolean) => void;
  onShiftPin: (id: string, direction: -1 | 1) => void;
  onResizePin: (id: string, size: HomePinSize) => void;
  onCustomizePin: (id: string, patch: HomePinCustomization) => void;
  onUnpin: (item: ResolvedPin) => void;
  onActivate: (item: ResolvedPin) => void;
  onContextMenu: (event: MouseEvent, item: ResolvedPin) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [customizingId, setCustomizingId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLButtonElement | null>(null);
  const holdRef = useRef<{ timer: number; x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const focusPinRef = useRef(false);
  const dragRef = useRef<{ id: string; placement: Placement | null } | null>(null);
  const lastDragPoint = useRef({ x: -1, y: -1 });
  const rectsRef = useRef(new Map<string, DOMRect>());
  const animationsRef = useRef<AnimationHandle[]>([]);
  const reducedMotion = useReducedMotion();
  const selected = items.find(item => item.pin.id === selectedId);
  const byId = new Map(items.map(item => [item.pin.id, item]));
  const ordered = draggedId && placement
    ? moveHomePin(items.map(item => item.pin), draggedId, placement.target, placement.after).map(pin => byId.get(pin.id)!)
    : items;
  const layoutKey = ordered.map(item => `${item.pin.id}:${item.size}`).join("|");

  function captureLayout() {
    rectsRef.current = new Map(Array.from(gridRef.current?.querySelectorAll<HTMLElement>(".quick-pin") ?? [])
      .map(element => [element.dataset.pinId!, element.getBoundingClientRect()]));
  }

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    grid.classList.add("tiles-enter");
    const timer = window.setTimeout(() => grid.classList.remove("tiles-enter"), TILE_MOTION.entranceWindow);
    return () => { window.clearTimeout(timer); grid.classList.remove("tiles-enter"); };
  }, [items.length > 0]);

  useLayoutEffect(() => {
    animationsRef.current.forEach(handle => handle.cancel());
    animationsRef.current = [];
    for (const element of gridRef.current?.querySelectorAll<HTMLElement>(".quick-pin") ?? []) {
      element.style.transform = "";
      const from = rectsRef.current.get(element.dataset.pinId!);
      const to = element.getBoundingClientRect();
      if (!from || !to.width || !to.height || reducedMotion) continue;
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      const sx = from.width / to.width;
      const sy = from.height / to.height;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(sx - 1) + Math.abs(sy - 1) < 0.01) continue;
      animationsRef.current.push(animateValue({ from: 0, to: 1,
        tween: { durationMs: MOTION_DURATIONS.content, easing: MOTION_TWEENS.standard },
        onUpdate: value => { element.style.transform = `translate(${dx * (1 - value)}px, ${dy * (1 - value)}px) scale(${sx + (1 - sx) * value}, ${sy + (1 - sy) * value})`; },
        onComplete: () => { element.style.transform = ""; },
      }));
    }
    rectsRef.current.clear();
  }, [layoutKey, reducedMotion]);

  useEffect(() => {
    if (items.length === 0) { setEditing(false); setSelectedId(null); }
    else if (!items.some(item => item.pin.id === selectedId)) {
      focusPinRef.current = editing;
      setSelectedId(items[0].pin.id);
    }
  }, [items, selectedId]);

  useLayoutEffect(() => {
    if (!editing || !focusPinRef.current) return;
    focusPinRef.current = false;
    const element = Array.from(gridRef.current?.children ?? []).find(child => (child as HTMLElement).dataset.pinId === selectedId);
    (element as HTMLElement | undefined)?.focus();
  }, [editing, selectedId, draggedId]);

  const clearHold = () => {
    if (holdRef.current) window.clearTimeout(holdRef.current.timer);
    holdRef.current = null;
  };
  useEffect(() => {
    window.addEventListener("pointerup", clearHold);
    window.addEventListener("blur", clearHold);
    return () => {
      clearHold();
      animationsRef.current.forEach(handle => handle.cancel());
      window.removeEventListener("pointerup", clearHold);
      window.removeEventListener("blur", clearHold);
    };
  }, []);

  function enterEdit(id: string) {
    focusPinRef.current = true;
    setSelectedId(id);
    setEditing(true);
  }
  function finishEdit() {
    pointerDrag.cancel();
    setEditing(false);
    setDraggedId(null);
    setPlacement(null);
    (editRef.current ?? gridRef.current?.closest(".quick-pins")?.querySelector<HTMLElement>(".quick-pins-edit"))?.focus();
  }
  function pointerDown(event: PointerEvent<HTMLElement>, item: ResolvedPin) {
    clearHold();
    suppressClickRef.current = false;
    if (event.button !== 0 || (event.target as HTMLElement).closest(".quick-pin-edit-tools")) return;
    if (editing) {
      event.preventDefault();
      setSelectedId(item.pin.id);
      event.currentTarget.focus();
      pointerDrag.begin(item.pin.id, event.currentTarget, event.pointerId, event.clientX, event.clientY);
      return;
    }
    const element = event.currentTarget;
    holdRef.current = { x: event.clientX, y: event.clientY, timer: window.setTimeout(() => {
      holdRef.current = null;
      suppressClickRef.current = true;
      element.querySelector(".tilt-pressed")?.classList.remove("tilt-pressed");
      enterEdit(item.pin.id);
      pointerDrag.begin(item.pin.id, element, event.pointerId, event.clientX, event.clientY);
    }, TILE_MOTION.longPress) };
  }
  function pinKey(event: KeyboardEvent<HTMLElement>, item: ResolvedPin) {
    if (event.key === "F2") { event.preventDefault(); event.stopPropagation(); enterEdit(item.pin.id); return; }
    if (editing && event.target === event.currentTarget && (event.key === " " || event.key === "Enter")) {
      event.preventDefault();
      event.stopPropagation();
      setCustomizingId(item.pin.id);
      return;
    }
    // An editing surface owns arrow keys; unmodified arrows must not seek or
    // change the volume through the app's transport shortcuts.
    if (editing && !event.altKey && event.key.startsWith("Arrow")) {
      event.preventDefault();
      event.stopPropagation();
      const index = ordered.findIndex(candidate => candidate.pin.id === item.pin.id);
      const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      const next = ordered[Math.max(0, Math.min(ordered.length - 1, index + direction))];
      focusPinRef.current = true;
      setSelectedId(next.pin.id);
      return;
    }
    if (!editing || !event.altKey) return;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    captureLayout();
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") onShiftPin(item.pin.id, event.key === "ArrowLeft" ? -1 : 1);
    else onResizePin(item.pin.id, stepHomePinSize(item.size, event.key === "ArrowUp" ? 1 : -1));
  }
  const pointerDrag = usePinDrag(gridRef, {
    onStart: id => {
      clearHold();
      dragRef.current = { id, placement: null };
      lastDragPoint.current = { x: -1, y: -1 };
      setSelectedId(id);
      setDraggedId(id);
    },
    onMove: previewDrop,
    onEnd: commit => {
      const drag = dragRef.current;
      captureLayout();
      if (commit && drag?.placement) onMovePin(drag.id, drag.placement.target, drag.placement.after);
      dragRef.current = null;
      setDraggedId(null);
      setPlacement(null);
      focusPinRef.current = true;
    },
  });
  function previewDrop(x: number, y: number) {
    const drag = dragRef.current;
    if (!drag) return;
    const viewport = gridRef.current?.closest<HTMLElement>(".quickplay-viewport");
    if (viewport) {
      const bounds = viewport.getBoundingClientRect();
      if (x > bounds.right - 48) viewport.scrollLeft += 18;
      else if (x < bounds.left + 48) viewport.scrollLeft -= 18;
    }
    if (Math.abs(x - lastDragPoint.current.x) + Math.abs(y - lastDragPoint.current.y) < 8) return;
    lastDragPoint.current = { x, y };
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>(".quick-pin");
    const grid = gridRef.current;
    if (element && !grid?.contains(element)) return;
    const target = element ? items.find(item => item.pin.id === element.dataset.pinId) : items[items.length - 1];
    if (!target || target.pin.id === drag.id) return;
    const bounds = (element ?? grid)?.getBoundingClientRect();
    if (!bounds || (!element && (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom))) return;
    const after = !element || y > bounds.top + bounds.height / 2;
    if (drag.placement?.target === target.pin.id && drag.placement.after === after) return;
    captureLayout();
    drag.placement = { target: target.pin.id, after };
    setPlacement(drag.placement);
  }
  const customization = items.find(item => item.pin.id === customizingId);
  const dialog = customization ? <PinAppearanceDialog key={customization.pin.id} item={customization}
    onClose={() => setCustomizingId(null)} onSave={patch => {
      captureLayout(); onCustomizePin(customization.pin.id, patch); setCustomizingId(null);
    }} /> : null;
  const lastDialog = useLastNonNull(dialog);

  return <article className="quick-group quick-pins" onKeyDown={event => {
    if (event.key === "Escape" && editing && !customizingId) { event.preventDefault(); event.stopPropagation(); finishEdit(); }
  }}>
    <div className="quick-section-title quick-pins-title">
      <h2>固定</h2>
      {items.length > 0 && <Button variant="ghost" size="sm" className="quick-pins-edit"
        aria-pressed={editing} onClick={event => {
          editRef.current = event.currentTarget;
          if (editing) finishEdit(); else enterEdit(selectedId ?? items[0].pin.id);
        }}>{editing ? "完成" : "编辑"}</Button>}
      {editing && selected && <Button variant="ghost" size="sm" className="quick-pins-customize"
        icon={<Palette size={16} />} onClick={() => setCustomizingId(selected.pin.id)}>外观</Button>}
    </div>
    {items.length === 0 ? <button className="quick-pins-empty" onClick={onOpenCollection}>
      <Pin size={22} /><span>固定音乐到这里</span>
    </button> : <>
      <div className="quick-section-scroll">
        <div ref={gridRef} className={`quick-pins-grid ${editing ? "editing" : ""}`}
          onPointerMove={pointerDrag.move} onPointerUp={pointerDrag.release}
          onPointerCancel={pointerDrag.cancel} onLostPointerCapture={pointerDrag.cancel}>
          {ordered.map((item, index) => <article key={item.pin.id} data-pin-id={item.pin.id}
            className={`quick-pin ${item.size} ${editing && selectedId === item.pin.id ? "selected" : ""} ${draggedId === item.pin.id ? "dragging" : ""} ${item.pin.tone && item.pin.tone !== "cover" ? "toned" : ""}`}
            style={{ "--tile-stagger-delay": `${Math.min(index * TILE_MOTION.stagger, TILE_MOTION.staggerMax)}ms`,
              "--pin-tone": HOME_PIN_TONES[item.pin.tone ?? "cover"].color } as CSSProperties}
            tabIndex={editing ? 0 : undefined} aria-label={editing ? `${item.title}，${SIZE_LABELS[item.size]}磁贴` : undefined}
            aria-describedby={editing ? "pin-edit-help" : undefined}
            onFocus={() => { if (editing) setSelectedId(item.pin.id); }}
            onKeyDown={event => pinKey(event, item)}
            onPointerDownCapture={event => pointerDown(event, item)}
            onPointerMove={event => {
              const hold = holdRef.current;
              if (hold && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 8) clearHold();
            }} onPointerLeave={clearHold} onPointerCancel={clearHold}
            onClickCapture={event => {
              if (suppressClickRef.current) { event.preventDefault(); event.stopPropagation(); suppressClickRef.current = false; }
            }}
            onContextMenu={event => {
              clearHold();
              if (editing || item.podcastFeed) { event.preventDefault(); enterEdit(item.pin.id); }
              else onContextMenu(event, item);
            }}
            onDragStart={event => event.preventDefault()}>
            <FlipTile size={item.size} variant={item.podcastFeed || item.size === "wide" ? "peek" : "flip"}
              className="quick-pin-tile" paused={editing} disabled={editing} asButton={!editing}
              live={item.pin.live !== false && item.size !== "small"}
              title={item.podcastFeed ? `打开节目 ${item.title}` : `播放 ${item.title}`}
              onPress={() => { if (!editing) onActivate(item); }}
              front={<PinFront item={item} index={index} paused={editing || item.pin.live === false} />}
              back={<>
                <span className="tile-back-kicker">{item.isSmart ? "智能歌单" : KIND_LABELS[item.pin.kind]}</span>
                <strong className="quick-pin-back-headline">{item.podcastFeed?.latestEpisodeTitle ?? item.title}</strong>
                <span className="tile-back-live">{[item.podcastRecency, item.liveLine].filter(Boolean).join(" · ")}</span>
                {(item.pin.kind === "track" || item.pin.kind === "album") && <small>{item.subtitle}</small>}
              </>} />
            {editing && selectedId === item.pin.id && <div className="quick-pin-edit-tools">
              <button className="quick-pin-unpin" title={`取消固定 ${item.title}`} onClick={() => { captureLayout(); onUnpin(item); }}><PinOff size={15} /></button>
              <button className="quick-pin-resize" title={`调整为${SIZE_LABELS[nextHomePinSize(item.size)]}磁贴`}
                onClick={() => { captureLayout(); onResizePin(item.pin.id, nextHomePinSize(item.size)); }}><ArrowDownLeft size={20} /></button>
            </div>}
          </article>)}
        </div>
      </div>
      {editing && <p className="quick-pins-help" id="pin-edit-help">拖动重排 · Alt + ← → 移动 · Alt + ↑ ↓ 缩放 · Esc 完成</p>}
    </>}
    {createPortal(<Presence show={dialog !== null} exitDurationMs={MOTION_DURATIONS.micro}>
      {dialog ?? lastDialog ?? <span hidden />}
    </Presence>, document.body)}
  </article>;
}

function PinFront({ item, index, paused }: { item: ResolvedPin; index: number; paused: boolean }) {
  const Icon = item.isSmart ? Sparkles : KIND_ICONS[item.pin.kind];
  const toned = item.pin.tone && item.pin.tone !== "cover";
  return <>
    <span className="tile-face-art">
      {toned ? <span className="quick-pin-symbol"><Icon aria-hidden="true" /></span>
        : <div className="quick-pin-art">
          {item.podcastFeed ? <Cover src={item.podcastArtwork} label={item.title} size="large" index={index} />
            : item.artPaths.length <= 1 || item.size === "small" ? <Cover artPath={item.artPaths[0]} label={item.title} size="large" index={index} />
              : <MosaicFrames paused={paused} pool={item.artPaths.map((artPath, artIndex) =>
                <Cover key={artPath} artPath={artPath} label={item.title} size="mini" index={index + artIndex} />)} />}
          {item.isSmart && item.size !== "small" && <Sparkles className="quick-pin-smart" size={21} aria-hidden="true" />}
        </div>}
    </span>
    {item.size !== "small" && (item.podcastFeed ? <span className="quick-pin-front-band">
      <strong>{item.title}</strong><small>{item.podcastFeed.unplayedCount > 0 ? item.liveLine : item.subtitle}</small>
    </span> : <strong className="quick-pin-front-title">{item.title}</strong>)}
    {item.size === "small" && (item.podcastFeed?.unplayedCount ?? 0) > 0 && <span className="quick-pin-badge">{item.podcastFeed!.unplayedCount > 99 ? "99+" : item.podcastFeed!.unplayedCount}</span>}
  </>;
}

function PinAppearanceDialog({ item, onClose, onSave }: { item: ResolvedPin; onClose: () => void; onSave: (patch: HomePinCustomization) => void }) {
  const [size, setSize] = useState(item.size);
  const [tone, setTone] = useState<HomePinTone>(item.pin.tone ?? "cover");
  const [live, setLive] = useState(item.pin.live !== false);
  return <Dialog titleId="pin-appearance-title" kicker="磁贴外观" title={item.title} className="pin-appearance-dialog"
    onCancel={onClose} onSubmit={event => { event.preventDefault(); onSave({ size, tone, live }); }}
    actions={<><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit">保存</Button></>}>
    <fieldset><legend>尺寸</legend><div className="pin-size-choices">
      {HOME_PIN_SIZES.map(value => <label key={value}><input type="radio" name="pin-size" value={value} checked={size === value} onChange={() => setSize(value)} /><span className={`pin-size-shape ${value}`} />{SIZE_LABELS[value]}</label>)}
    </div></fieldset>
    <fieldset><legend>背景</legend><div className="pin-tone-choices">
      {(Object.entries(HOME_PIN_TONES) as [HomePinTone, { label: string; color: string }][]).map(([value, info]) =>
        <label key={value} title={info.label}><input type="radio" name="pin-tone" value={value} aria-label={info.label} checked={tone === value} onChange={() => setTone(value)} />
          <span style={{ background: info.color }}>{value === "cover" ? <Cover artPath={item.artPaths[0]} src={item.podcastFeed ? item.podcastArtwork : undefined} label={item.title} size="mini" /> : null}</span>
          <small>{info.label}</small></label>)}
    </div></fieldset>
    <label className="pin-live-choice"><input type="checkbox" checked={live} onChange={event => setLive(event.target.checked)} />动态内容</label>
    <p className="pin-live-hint">{size === "small" ? "小磁贴保持静态，放大后使用此设置。" : "翻面显示歌曲信息、收听记录或节目更新。"}</p>
  </Dialog>;
}
