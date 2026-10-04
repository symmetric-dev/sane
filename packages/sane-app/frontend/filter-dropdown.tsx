import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import "./filter-dropdown.css";

type Option = { value: string; label: string };
type Props = {
  label: string;
  value: string;
  options: Option[];
  disabled?: boolean;
  onChange: (value: string) => void;
};

/** Select-only combobox kept inside the modal's focus and stacking context. */
export function FilterDropdown({ label, value, options, disabled = false, onChange }: Props) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", time: 0 });
  const [active, setActive] = useState<number | null>(null);
  const [placement, setPlacement] = useState({ above: false, maxHeight: 240 });
  const selected = options.findIndex(option => option.value === value);
  const open = active !== null && !disabled;
  const activeIndex = Math.min(active ?? 0, options.length - 1);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setActive(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  useEffect(() => { if (disabled) setActive(null); }, [disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const button = trigger.current;
      if (!button) return;
      const bounds = button.getBoundingClientRect();
      const modal = button.closest("dialog")?.getBoundingClientRect();
      const below = Math.min(window.innerHeight, modal?.bottom ?? window.innerHeight) - bounds.bottom - 12;
      const above = bounds.top - Math.max(0, modal?.top ?? 0) - 12;
      const upwards = below < 200 && above > below;
      setPlacement({ above: upwards, maxHeight: Math.max(40, Math.min(240, upwards ? above : below)) });
    };
    position();
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [open]);

  useEffect(() => {
    const menu = list.current;
    const option = menu?.children[activeIndex] as HTMLElement | undefined;
    if (!open || !menu || !option) return;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
    }
  }, [open, activeIndex]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setActive(null);
    trigger.current?.focus({ preventScroll: true });
  };

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setActive(null);
    } else if (event.key === "Tab") {
      setActive(null);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActive(open ? Math.max(0, Math.min(options.length - 1, activeIndex + direction)) : Math.max(0, selected));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(activeIndex);
      else setActive(Math.max(0, selected));
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      const text = (now - search.current.time < 700 ? search.current.text : "") + event.key.toLowerCase();
      search.current = { text, time: now };
      const match = options.findIndex(option => option.label.toLowerCase().startsWith(text));
      if (match !== -1) setActive(match);
    }
  };

  return <div ref={root} className="filter-dropdown" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(null);
  }}>
    <span id={`${id}-label`} className="filter-dropdown-label">{label}</span>
    <div className="filter-dropdown-control">
    <button ref={trigger} type="button" role="combobox" className="filter-dropdown-trigger" disabled={disabled}
      aria-labelledby={`${id}-label`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined}
      aria-activedescendant={open ? `${id}-option-${activeIndex}` : undefined} onKeyDown={keyDown}
      onClick={() => setActive(open ? null : Math.max(0, selected))}>
      <span>{options[selected]?.label ?? value}</span><span className="filter-dropdown-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && <div ref={list} id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`}
      className={`filter-dropdown-list${placement.above ? " filter-dropdown-list-above" : ""}`} style={{ maxHeight: placement.maxHeight }}>
      {options.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} role="option"
        aria-selected={option.value === value} className={`filter-dropdown-option${index === activeIndex ? " active" : ""}`}
        onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(index)}>
        <span>{option.label}</span><span className="filter-dropdown-check" aria-hidden="true">{option.value === value ? "✓" : ""}</span>
      </div>)}
    </div>}
    </div>
  </div>;
}
