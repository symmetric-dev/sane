import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import type { ActivityEntry, ActivityPlan } from "./transcript-activity";
import { ActivityLabel } from "./activity-ui";
import { ShellDialog } from "./shell-dialog";

type ActivitySelection = { id: string; scope: string; trigger: HTMLButtonElement };

export function useActivityInspection({ scope, active = true, plan }: { scope: string; active?: boolean; plan: ActivityPlan }) {
  const [selection, setSelection] = useState<ActivitySelection | null>(null);
  const origin = useRef<ActivitySelection | null>(null);
  const current = useRef({ scope, plan });
  current.current = { scope, plan };
  if (selection) origin.current = selection;
  const selected = active && selection?.scope === scope ? plan.byId.get(selection.id) : undefined;
  const group = selected ? plan.groupByEntry.get(selected.id) : undefined;
  useLayoutEffect(() => {
    if (selection && (!active || selection.scope !== scope || !selected || !group)) setSelection(null);
  }, [active, scope, selection, selected, group]);
  const open = useCallback((entryId: string, trigger: HTMLButtonElement) => {
    if (!active || !plan.byId.has(entryId) || !plan.groupByEntry.has(entryId)) return;
    setSelection({ id: entryId, scope, trigger });
  }, [active, scope, plan]);
  const close = useCallback(() => setSelection(null), []);
  const select = useCallback((entryId: string) => {
    setSelection(previous => {
      if (!active || previous?.scope !== scope) return previous;
      const previousGroup = plan.groupByEntry.get(previous.id);
      const nextGroup = plan.groupByEntry.get(entryId);
      return plan.byId.has(entryId) && previousGroup && nextGroup?.id === previousGroup.id ? { ...previous, id: entryId } : previous;
    });
  }, [active, scope, plan]);
  const restoreFocus = useCallback(() => {
    const previous = origin.current;
    if (!previous) return null;
    const groupId = (current.current.scope === previous.scope ? current.current.plan.groupByEntry.get(previous.id)?.id : undefined) ?? previous.trigger.dataset.activityGroupId;
    const matches = (button: HTMLButtonElement) => button.dataset.activityScope === previous.scope && button.dataset.activityGroupId === groupId;
    const target = previous.trigger.isConnected && matches(previous.trigger) ? previous.trigger : Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-activity-group-id][data-activity-scope]")).find(matches) ?? null;
    target?.focus({ preventScroll: true });
    return target;
  }, []);
  return { scope, open, close, select, selected: group ? selected : undefined, group, restoreFocus };
}

export type ActivityInspection = ReturnType<typeof useActivityInspection>;

export function ActivityInspector({ inspection, renderBody }: { inspection: ActivityInspection; renderBody: (entry: ActivityEntry) => ReactNode }) {
  const domId = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const { selected, group } = inspection;
  if (!selected || !group) return null;
  const selectedIndex = group.entries.findIndex(entry => entry.id === selected.id);
  const panelId = `${domId}-body`;
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const next = event.key === "Home" ? 0 : event.key === "End" ? group.entries.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + group.entries.length) % group.entries.length;
    const entry = group.entries[next]!;
    inspection.select(entry.id);
    buttons.current.get(entry.id)?.focus();
  };
  return <div className="activity-inspector-host" {...{ onCancel: (event: SyntheticEvent) => event.stopPropagation() }} onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
    <ShellDialog title="Activity Group" subtitle="Inspect agent activity inputs and outputs" className="activity-inspector" close={inspection.close} restoreFocus={inspection.restoreFocus} initialFocus={() => buttons.current.get(selected.id) ?? null}>
      <div className="activity-inspector-layout">
        <div className="activity-inspector-list" role="tablist" aria-label="Activity entries" aria-orientation="vertical">
          {group.entries.map((entry, index) => <button type="button" role="tab" key={entry.id} id={`${domId}-entry-${index}`} ref={button => { if (button) buttons.current.set(entry.id, button); else buttons.current.delete(entry.id); }}
            className="activity-inspector-entry" aria-selected={entry.id === selected.id} aria-controls={panelId} tabIndex={entry.id === selected.id ? 0 : -1} onClick={() => inspection.select(entry.id)} onKeyDown={event => navigate(event, index)}>
            <span className="activity-inspector-ordinal" aria-label={`Entry ${index + 1}`}>{index + 1}</span><ActivityLabel entry={entry} />
          </button>)}
        </div>
        <div key={selected.id} id={panelId} className="activity-inspector-body" role="tabpanel" aria-labelledby={`${domId}-entry-${selectedIndex}`} tabIndex={0}>
          {renderBody(selected)}
        </div>
      </div>
    </ShellDialog>
  </div>;
}
