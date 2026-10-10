import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabDef<Id extends string> {
  id: Id;
  label: string;
  /** Optional count shown next to the label. */
  badge?: ReactNode;
  panel: ReactNode;
}

interface TabsProps<Id extends string> {
  tabs: TabDef<Id>[];
  active: Id;
  onChange(id: Id): void;
  label: string;
}

/**
 * WAI-ARIA tabs with roving focus (arrow keys, Home, End). Inactive panels stay mounted but
 * hidden, so form state and scroll positions survive tab switches and regenerations.
 */
export function Tabs<Id extends string>({ tabs, active, onChange, label }: TabsProps<Id>) {
  const baseId = useId();
  const refs = useRef(new Map<Id, HTMLButtonElement>());

  const focusTab = (index: number) => {
    const tab = tabs[(index + tabs.length) % tabs.length];
    onChange(tab.id);
    refs.current.get(tab.id)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === 'ArrowRight') focusTab(index + 1);
    else if (e.key === 'ArrowLeft') focusTab(index - 1);
    else if (e.key === 'Home') focusTab(0);
    else if (e.key === 'End') focusTab(tabs.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <div className="tabs">
      <div role="tablist" aria-label={label} className="tablist">
        {tabs.map((tab, index) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                if (el) refs.current.set(tab.id, el);
                else refs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              className={`tab${selected ? ' is-active' : ''}`}
              onClick={() => onChange(tab.id)}
              onKeyDown={(e) => onKeyDown(e, index)}
            >
              {tab.label}
              {tab.badge !== undefined && (
                <>
                  {' '}
                  <span className="tab-badge">{tab.badge}</span>
                </>
              )}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${baseId}-panel-${tab.id}`}
          aria-labelledby={`${baseId}-tab-${tab.id}`}
          hidden={tab.id !== active}
          tabIndex={0}
          className="tabpanel"
        >
          {tab.panel}
        </div>
      ))}
    </div>
  );
}
