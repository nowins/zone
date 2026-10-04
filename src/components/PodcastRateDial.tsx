import { useEffect, useMemo, useRef, type PointerEvent } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "./Button";
import { PODCAST_PLAYBACK_RATES } from "../app/podcastPlaybackSettings";

export function PodcastRateDial({ value, onChange, label = "播放速度", disabled = false }: {
  value: number; onChange: (rate: number) => void; label?: string; disabled?: boolean;
}) {
  const rates = useMemo(() => Array.from(new Set<number>([...PODCAST_PLAYBACK_RATES,
    ...(Number.isFinite(value) && value >= 0.5 && value <= 3 ? [value] : []),
  ])).sort((a, b) => a - b), [value]);
  const index = Math.max(0, rates.indexOf(value));
  const dialRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ rates, index, disabled, onChange });
  latest.current = { rates, index, disabled, onChange };
  const drag = useRef<{ id: number; x: number; y: number; index: number; rates: number[] } | null>(null);
  const wheel = useRef(0);
  function select(next: number) {
    const state = latest.current;
    if (state.disabled) return;
    const rate = state.rates[Math.max(0, Math.min(state.rates.length - 1, next))];
    if (rate !== state.rates[state.index]) state.onChange(rate);
  }
  useEffect(() => {
    const dial = dialRef.current;
    if (!dial) return;
    function onWheel(event: WheelEvent) {
      if (latest.current.disabled || document.activeElement !== dial || event.ctrlKey) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1);
      if (Math.sign(delta) !== Math.sign(wheel.current)) wheel.current = 0;
      wheel.current += delta;
      if (Math.abs(wheel.current) >= 40) {
        select(latest.current.index + (wheel.current < 0 ? 1 : -1));
        wheel.current = 0;
      }
    }
    dial.addEventListener("wheel", onWheel, { passive: false });
    return () => dial.removeEventListener("wheel", onWheel);
  }, []);
  useEffect(() => { if (disabled) drag.current = null; }, [disabled]);
  function finish(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  const angle = -135 + ((value - 0.5) / 2.5) * 270;
  return <div className="podcast-rate-dial-control">
    <div className="podcast-rate-dial-row">
      <Button variant="ghost" aria-label={`降低${label}`} disabled={disabled || index === 0} onClick={() => select(index - 1)}><Minus size={15} aria-hidden="true" /></Button>
      <div ref={dialRef} className="podcast-rate-dial" role="slider" tabIndex={disabled ? -1 : 0}
        aria-label={label} aria-valuemin={0.5} aria-valuemax={3} aria-valuenow={value} aria-valuetext={`${value} 倍速`} aria-disabled={disabled}
        title="拖动或聚焦后滚轮调节 · 方向键微调" onBlur={() => { wheel.current = 0; drag.current = null; }}
        onKeyDown={event => {
          const next = event.key === "Home" ? 0 : event.key === "End" ? rates.length - 1
            : ["ArrowUp", "ArrowRight"].includes(event.key) ? index + 1
            : ["ArrowDown", "ArrowLeft"].includes(event.key) ? index - 1 : null;
          if (next === null || disabled) return;
          event.preventDefault(); event.stopPropagation(); select(next);
        }}
        onPointerDown={event => {
          if (disabled || event.button !== 0 || event.isPrimary === false) return;
          event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, index, rates };
        }}
        onPointerMove={event => {
          const start = drag.current;
          if (!start || start.id !== event.pointerId || disabled) return;
          const step = Math.round(((event.clientX - start.x) + (start.y - event.clientY)) / 18);
          const rate = start.rates[Math.max(0, Math.min(start.rates.length - 1, start.index + step))];
          if (rate !== latest.current.rates[latest.current.index]) latest.current.onChange(rate);
        }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { drag.current = null; }}>
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="42" className="podcast-rate-dial-track" />
          {PODCAST_PLAYBACK_RATES.map(rate => <line key={rate} x1="50" x2="50" y1="4" y2="9" transform={`rotate(${-135 + (rate - 0.5) / 2.5 * 270} 50 50)`} />)}
          <g transform={`rotate(${angle} 50 50)`}><line x1="50" x2="50" y1="11" y2="19" className="podcast-rate-dial-needle" /></g>
        </svg>
        <span aria-hidden="true">{value}<small>×</small></span>
      </div>
      <Button variant="ghost" aria-label={`提高${label}`} disabled={disabled || index === rates.length - 1} onClick={() => select(index + 1)}><Plus size={15} aria-hidden="true" /></Button>
    </div>
    <Button variant="ghost" disabled={disabled || value === 1} onClick={() => onChange(1)}>恢复原速</Button>
  </div>;
}
