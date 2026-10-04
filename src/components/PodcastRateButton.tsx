import { Button } from "./Button";

const QUICK_RATES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

export function PodcastRateButton({ value, onChange, label = "播放速度", scope = "default", disabled, className = "" }: {
  value: number;
  onChange: (value: number) => void;
  label?: string;
  scope?: "default" | "show";
  disabled?: boolean;
  className?: string;
}) {
  const current = Number.isFinite(value) ? value : 1;
  const next = QUICK_RATES.find(rate => rate > current) ?? 1;
  const text = `${Number(current.toFixed(2))}×`;
  return <Button variant="ghost" className={`podcast-rate-button ${className}`.trim()} disabled={disabled}
    aria-label={`${label}，当前 ${text}，切换至 ${next}×`}
    title={`${scope === "show" ? "本节目倍速" : "默认倍速"} · 点击切换至 ${next}×`}
    onClick={() => onChange(next)}>{text}</Button>;
}
