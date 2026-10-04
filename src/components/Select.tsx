import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Presence, useLastNonNull } from "../motion/presence";
import { MOTION_DURATIONS } from "../motion/tokens";

interface Option { value: string; label: ReactNode; disabled: boolean }
function optionText(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child)
    ? optionText(child.props.children) : String(child)).join("");
}

function SelectMenu({ id, label, options, active, selected, position, onChoose }: {
  id: string; label: string; options: Option[]; active: number; selected: string;
  position: CSSProperties; onChoose: (value: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // The top layer escapes scroll clipping and transforms while remaining
    // inside the owning dialog's DOM and focus isolation boundary.
    const menu = ref.current;
    if (menu?.showPopover) { menu.setAttribute("popover", "manual"); menu.showPopover(); return () => menu.hidePopover(); }
  }, []);
  useLayoutEffect(() => {
    const menu = ref.current, option = menu?.querySelector<HTMLElement>('[data-active="true"]');
    if (!menu || !option) return;
    // Scroll only the popup. scrollIntoView can move its DOM ancestors even in the top layer.
    const top = option.offsetTop, bottom = top + option.offsetHeight;
    if (top < menu.scrollTop) menu.scrollTop = top;
    else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
  }, [active]);
  return <div ref={ref} id={id} className="select-menu" role="listbox" aria-label={label} style={position}
    onMouseDown={event => event.preventDefault()} onClick={event => { event.preventDefault(); event.stopPropagation(); }}>
    {options.map((option, index) => <div key={option.value} id={`${id}-${index}`} className="select-option" role="option"
      aria-selected={selected === option.value} aria-disabled={option.disabled} data-active={index === active}
      data-value={option.value} title={optionText(option.label)}
      onClick={() => { if (!option.disabled) onChoose(option.value); }}>
      <span>{option.label}</span>{selected === option.value && <Check size={14} aria-hidden="true" />}
    </div>)}
  </div>;
}

/** Controlled, single-selection dropdown. Option children are data only. */
export function Select({ value, onValueChange, children, className = "", disabled = false, "aria-label": label }: {
  value: string | number; onValueChange: (value: string) => void; children: ReactNode;
  className?: string; disabled?: boolean; "aria-label": string;
}) {
  const id = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const options = Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ value: string | number; children: ReactNode; disabled?: boolean }>(child)) return [];
    return [{ value: String(child.props.value), label: child.props.children, disabled: Boolean(child.props.disabled) }];
  });
  const selected = String(value);
  const selectedIndex = options.findIndex(option => option.value === selected);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({});
  const search = useRef({ text: "", at: 0 });
  function close() { setOpen(false); search.current.text = ""; }
  function move(from: number, direction: number) {
    for (let next = from + direction; next >= 0 && next < options.length; next += direction) {
      if (!options[next].disabled) return next;
    }
    return from;
  }
  function show() {
    if (disabled || !options.some(option => !option.disabled)) return;
    const rect = triggerRef.current!.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const up = below < Math.min(280, options.length * 36 + 8) && above > below;
    const height = Math.max(36, Math.min(280, up ? above - 6 : below - 6));
    const width = Math.min(Math.max(rect.width, 180), window.innerWidth - 24);
    setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width,
      maxHeight: height, ...(up ? { bottom: window.innerHeight - rect.top + 6, top: "auto" } : { top: rect.bottom + 6, bottom: "auto" }),
      transformOrigin: up ? "bottom left" : "top left" });
    setActive(selectedIndex >= 0 && !options[selectedIndex].disabled ? selectedIndex : move(-1, 1));
    setOpen(true);
  }
  useEffect(() => { if (disabled) close(); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    function outside(event: Event) { if (!rootRef.current?.contains(event.target as Node)) close(); }
    function scroll(event: Event) { if (!(event.target as Element)?.closest?.('.select-menu')) close(); }
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  const menu = open && !disabled ? <SelectMenu id={id} label={label} options={options} active={active} selected={selected}
    position={position} onChoose={next => { onValueChange(next); close(); triggerRef.current?.focus(); }} /> : null;
  const lastMenu = useLastNonNull(menu);
  return <span ref={rootRef} className={`select-control ${className}`} data-select-open={open && !disabled}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) close(); }}>
    <button ref={triggerRef} className="select-trigger" type="button" role="combobox" disabled={disabled}
      aria-label={label} aria-expanded={open && !disabled} aria-haspopup="listbox" aria-controls={open ? id : undefined}
      aria-activedescendant={open ? `${id}-${active}` : undefined} data-value={selected}
      title={optionText(options[selectedIndex]?.label)}
      onClick={() => open ? close() : show()} onKeyDown={event => {
        if (event.key === "Tab") { close(); return; }
        if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (["Enter", " "].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          if (!open) show(); else if (options[active] && !options[active].disabled) { onValueChange(options[active].value); close(); }
          return;
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          if (!open) { show(); return; }
          setActive(event.key === "Home" ? move(-1, 1) : event.key === "End" ? move(options.length, -1) : move(active, event.key === "ArrowDown" ? 1 : -1));
          return;
        }
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing) {
          const now = Date.now();
          search.current.text = now - search.current.at > 700 ? event.key : search.current.text + event.key;
          search.current.at = now;
          if (!open) show();
          const next = options.findIndex(option => !option.disabled && optionText(option.label).toLocaleLowerCase().startsWith(search.current.text.toLocaleLowerCase()));
          if (next >= 0) setActive(next);
          event.preventDefault(); event.stopPropagation();
        }
      }}><span>{options[selectedIndex]?.label ?? "请选择"}</span><ChevronDown size={14} aria-hidden="true" /></button>
    <Presence show={menu !== null} exitDurationMs={MOTION_DURATIONS.micro}>{menu ?? lastMenu ?? <span hidden />}</Presence>
  </span>;
}
