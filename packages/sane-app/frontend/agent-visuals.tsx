import type { CSSProperties, KeyboardEvent } from "react";
import type { IconType } from "react-icons";
import { FiBookOpen, FiBox, FiCheck, FiCircle, FiClipboard, FiCode, FiCoffee, FiCompass, FiCpu, FiDatabase, FiFeather, FiFlag, FiGitBranch, FiGlobe, FiLayers, FiMoon, FiPenTool, FiSearch, FiShield, FiStar, FiSun, FiTarget, FiTerminal, FiTool, FiZap } from "react-icons/fi";
import type { AgentColor, AgentColorId, AgentIconId, AgentProfile } from "../src/agent-profiles-contract";
import { harnessName, harnessShort } from "./types";

export const AGENT_ICONS: Record<AgentIconId, IconType> = {
  circle: FiCircle, compass: FiCompass, "pen-tool": FiPenTool, layers: FiLayers, cpu: FiCpu, zap: FiZap, "book-open": FiBookOpen, clipboard: FiClipboard,
  search: FiSearch, code: FiCode, terminal: FiTerminal, tool: FiTool, target: FiTarget, flag: FiFlag, feather: FiFeather, box: FiBox,
  database: FiDatabase, "git-branch": FiGitBranch, globe: FiGlobe, shield: FiShield, star: FiStar, sun: FiSun, moon: FiMoon, coffee: FiCoffee,
};
export const AGENT_COLORS: Record<AgentColorId, string> = {
  slate: "var(--agent-slate)", violet: "var(--agent-violet)", blue: "var(--agent-blue)", teal: "var(--agent-teal)",
  green: "var(--agent-green)", amber: "var(--agent-amber)", orange: "var(--agent-orange)", rose: "var(--agent-rose)",
};
export const agentColor = (color: AgentColor | string | undefined) => color && color in AGENT_COLORS ? AGENT_COLORS[color as AgentColorId] : /^#[0-9a-f]{3,8}$/i.test(color ?? "") ? color! : AGENT_COLORS.slate;
export const profileSummary = (profile: Pick<AgentProfile, "model" | "effort">) => profile.model ? [profile.model, profile.effort].filter(Boolean).join(" · ") : profile.effort ? `Default model · ${profile.effort}` : "Defaults";

type Visual = Pick<AgentProfile, "icon" | "color" | "label">;
export function AgentAvatar({ profile, size = 32 }: { profile: Visual; size?: number }) {
  const Glyph = AGENT_ICONS[profile.icon] ?? FiCircle;
  return <span className="agent-avatar" aria-hidden="true" style={{ "--agent-color": agentColor(profile.color), width: size, height: size } as CSSProperties}><Glyph size={Math.round(size * .5)} /></span>;
}

/** Shared profile tile for the picker and the Config grid. */
export function AgentCard({ profile, selected, disabled, reason, tag, onSelect, onKeyDown }: { profile: AgentProfile; selected?: boolean; disabled?: boolean; reason?: string; tag?: string; onSelect?: () => void; onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void }) {
  return <button type="button" className="agent-card" aria-pressed={selected} aria-disabled={disabled || undefined} title={disabled ? reason : profile.description || undefined} data-agent-id={profile.id} onKeyDown={onKeyDown} onClick={() => { if (!disabled) onSelect?.(); }}>
    <span className="agent-card-head"><AgentAvatar profile={profile} />{selected && <span className="agent-card-check" aria-hidden="true"><FiCheck size={12} /></span>}</span>
    <span className="agent-card-label">{profile.label}{tag && <span className="harness-badge">{tag}</span>}</span>
    <span className="agent-card-description">{profile.description || (profile.kind === "base" ? "Harness defaults." : "SANE assistant.")}</span>
    <span className="agent-card-footer"><span className="harness-badge" title={harnessName(profile.harness)}>{harnessShort(profile.harness)}</span><span className="agent-card-model">{profileSummary(profile)}</span></span>
    {disabled && reason && <span className="sr-only">Unavailable: {reason}</span>}
  </button>;
}

/** Arrow-key roving focus across `.agent-card` buttons inside `container`. */
export function moveCardFocus(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null) {
  if (!container || !["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const cards = [...container.querySelectorAll<HTMLButtonElement>(".agent-card")];
  const index = cards.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const current = cards[index]!, top = current.offsetTop;
  const columns = Math.max(1, cards.filter(c => c.offsetTop === top && c.parentElement === current.parentElement).length);
  const next = event.key === "Home" ? 0 : event.key === "End" ? cards.length - 1 : index + (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "ArrowDown" ? columns : -columns);
  cards[Math.min(cards.length - 1, Math.max(0, next))]?.focus();
}
