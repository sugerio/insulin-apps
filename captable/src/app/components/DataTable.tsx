import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../auth/AuthProvider.tsx";
import { compareDecimals, compareRatios } from "../lib/decimal.ts";
import { formatDate } from "../lib/format.ts";
import { Icon } from "./Icon.tsx";

// The list table: a search box, Filters (a popover; active filters show as removable
// chips), Columns (a checkbox list with per-table defaults, remembered per user), a density toggle, sortable headers,
// and "Showing a to b of N results" with Previous/Next and a page-size menu. Lists come whole from the API, so all
// of this runs in the browser.

export interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  numeric?: boolean;
  /** Present when the column sorts. */
  compare?: (a: T, b: T) => number;
  defaultHidden?: boolean;
  /** Always shown; not in the column chooser. */
  locked?: boolean;
  sticky?: boolean;
  stickyRight?: boolean;
  className?: string;
  headerClassName?: string;
  minWidth?: number;
}

export type DateRange = { from?: string; to?: string };
export type Filter<T> =
  | { key: string; label: string; type?: "select"; options: readonly (readonly [string, string])[]; test: (row: T, value: string) => boolean }
  | { key: string; label: string; type: "multi"; options: readonly (readonly [string, string])[]; test: (row: T, values: string[]) => boolean }
  | { key: string; label: string; type: "daterange"; test: (row: T, range: DateRange) => boolean };
type FilterState = Record<string, string | string[] | DateRange | undefined>;

export interface DataTableProps<T> {
  /** Names the remembered column choice. */
  id: string;
  label: string;
  rows: readonly T[];
  rowKey: (row: T) => string;
  columns: readonly Column<T>[];
  defaultSort?: readonly [key: string, direction: "asc" | "desc"];
  pageSize?: number;
  paginate?: boolean;
  toolbar?: boolean;
  search?: (row: T) => string;
  searchPlaceholder?: string;
  filters?: readonly Filter<T>[];
  /** Extra toolbar controls, e.g. a Download button. */
  toolbarExtra?: ReactNode;
  empty?: ReactNode;
  /** Rows pinned under the body: the cap table's "Available pool" and "Totals". */
  pinned?: (context: { columns: readonly Column<T>[]; rows: readonly T[]; filtered: boolean }) => ReactNode;
  onRowClick?: (row: T) => void;
  rowLabel?: (row: T) => string;
}

export const PAGE_SIZES = [10, 25, 50, 100] as const;

// Comparators for the column specs.
export const byText = <T,>(get: (row: T) => string | null | undefined) => (a: T, b: T) =>
  (get(a) ?? "").localeCompare(get(b) ?? "", undefined, { numeric: true, sensitivity: "base" });
export const byDecimal = <T,>(get: (row: T) => string | null | undefined) => (a: T, b: T) => compareDecimals(get(a) ?? "0", get(b) ?? "0");
export const byRatio = <T,>(get: (row: T) => string | null | undefined) => (a: T, b: T) => compareRatios(get(a) ?? "0", get(b) ?? "0");
export const byNumber = <T,>(get: (row: T) => number | null | undefined) => (a: T, b: T) => (get(a) ?? -Infinity) - (get(b) ?? -Infinity);
/** Display ids in their natural order: CS-2 before CS-10, then by prefix. */
export const byDisplayId = <T,>(get: (row: T) => string) => (a: T, b: T) => {
  const split = (id: string) => /^(.*?)(\d*)$/.exec(id) ?? ["", id, ""];
  const [, pa = "", na = ""] = split(get(a));
  const [, pb = "", nb = ""] = split(get(b));
  return pa === pb ? Number(na || 0) - Number(nb || 0) : pa.localeCompare(pb);
};

interface Prefs {
  columns: Record<string, boolean>;
  pageSize?: number;
  dense?: boolean;
}

function prefsKey(userId: string, id: string) {
  return `captable.table.v1.${userId}.${id}`;
}

function loadPrefs(key: string): Prefs {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
    if (parsed && typeof parsed === "object" && "columns" in parsed) return parsed as Prefs;
  } catch {
    // Unreadable or blocked storage: the defaults apply.
  }
  return { columns: {} };
}

function savePrefs(key: string, prefs: Prefs) {
  try {
    window.localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    // Storage can be full or blocked; the choice then lasts for this visit only.
  }
}

function isActive(value: FilterState[string]): boolean {
  if (value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Boolean(value.from || value.to);
  return true;
}

function Popover({ label, count, icon, children }: { label: string; count?: number; icon: "filter" | "columns"; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="menu" ref={root}>
      <button ref={button} type="button" className="btn btn-ghost btn-sm" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
        <Icon name={icon} /> {label}
        {count ? <span className="sb-count">{count}</span> : null}
      </button>
      {open ? (
        <div
          className="pop"
          id={id}
          role="group"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              button.current?.focus();
            }
          }}
        >
          {children}
          <div className="row mt-8">
            <span className="spacer" />
            <button type="button" className="btn btn-primary btn-sm" onClick={() => { setOpen(false); button.current?.focus(); }}>Done</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A table's search, filters, sort, page and saved column choice belong to that table (per user, per table id), so a
 * different table id — the Shares tab after the Options tab, say — starts from its own state rather than inheriting.
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const userId = useAuth().me?.user.id ?? "anonymous";
  const storageKey = prefsKey(userId, props.id);
  return <TableState key={storageKey} storageKey={storageKey} {...props} />;
}

function TableState<T>(props: DataTableProps<T> & { storageKey: string }) {
  const { label, rows, rowKey, columns, defaultSort, paginate = true, toolbar = true, search, filters = [], pinned, onRowClick, storageKey } = props;
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(storageKey));
  const [query, setQuery] = useState("");
  const [filterState, setFilterState] = useState<FilterState>({});
  const [sort, setSort] = useState<readonly [string, "asc" | "desc"] | null>(defaultSort ?? null);
  const [page, setPage] = useState(0);
  const pageSize = paginate ? prefs.pageSize ?? props.pageSize ?? 10 : Number.POSITIVE_INFINITY;

  const updatePrefs = (next: Prefs) => {
    setPrefs(next);
    savePrefs(storageKey, next);
  };

  const visibleColumns = columns.filter((column) => column.locked || (prefs.columns[column.key] ?? !column.defaultHidden));
  const choosable = columns.filter((column) => !column.locked);
  const hasOptional = columns.some((column) => column.defaultHidden);
  const filtered = query.trim() !== "" || Object.values(filterState).some(isActive);

  const shown = useMemo(() => {
    let result = [...rows];
    const needle = query.trim().toLowerCase();
    if (needle && search) result = result.filter((row) => search(row).toLowerCase().includes(needle));
    for (const filter of filters) {
      const value = filterState[filter.key];
      if (!isActive(value)) continue;
      if (filter.type === "multi") result = result.filter((row) => filter.test(row, value as string[]));
      else if (filter.type === "daterange") result = result.filter((row) => filter.test(row, value as DateRange));
      else result = result.filter((row) => filter.test(row, value as string));
    }
    const column = sort ? columns.find((item) => item.key === sort[0]) : undefined;
    if (sort && column?.compare) {
      const direction = sort[1] === "asc" ? 1 : -1;
      const compare = column.compare;
      result.sort((a, b) => direction * compare(a, b));
    }
    return result;
  }, [rows, query, search, filters, filterState, sort, columns]);

  const total = shown.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pages - 1);
  const start = current * pageSize;
  const pageRows = paginate ? shown.slice(start, start + pageSize) : shown;

  const setFilter = (key: string, value: FilterState[string]) => {
    setFilterState((previous) => ({ ...previous, [key]: value }));
    setPage(0);
  };

  const chips = filters.flatMap((filter) => {
    const value = filterState[filter.key];
    if (!isActive(value)) return [];
    let text: string;
    if (filter.type === "daterange") {
      const range = value as DateRange;
      text = `${range.from ? formatDate(range.from) : "…"} → ${range.to ? formatDate(range.to) : "…"}`;
    } else {
      const values = Array.isArray(value) ? value : [value as string];
      text = values.map((item) => filter.options.find(([key]) => key === item)?.[1] ?? item).join(", ");
    }
    return [
      <span className="chip" key={filter.key}>
        {filter.label}: {text}
        <button type="button" aria-label={`Remove filter ${filter.label}`} onClick={() => setFilter(filter.key, undefined)}>
          <Icon name="x" />
        </button>
      </span>,
    ];
  });

  return (
    <div className="dt">
      {toolbar ? (
        <div className="dt-toolbar">
          {search ? (
            <label className="dt-search">
              <Icon name="search" />
              <span className="sr-only">Search {label.toLowerCase()}</span>
              <input
                type="search"
                value={query}
                placeholder={props.searchPlaceholder ?? "Search…"}
                autoComplete="off"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
            </label>
          ) : (
            <div className="spacer" />
          )}
          {props.toolbarExtra}
          {filters.length ? (
            <Popover label="Filters" icon="filter" count={Object.values(filterState).filter(isActive).length}>
              <h4>Filters</h4>
              {filters.map((filter) => (
                <FilterControl key={filter.key} filter={filter} value={filterState[filter.key]} onChange={(value) => setFilter(filter.key, value)} />
              ))}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setFilterState({}); setPage(0); }}>Clear</button>
            </Popover>
          ) : null}
          {hasOptional ? (
            <Popover label="Columns" icon="columns">
              <h4>Columns</h4>
              <div className="checks">
                {choosable.map((column) => (
                  <label key={column.key}>
                    <input
                      type="checkbox"
                      className="cb"
                      checked={visibleColumns.includes(column)}
                      onChange={(event) => updatePrefs({ ...prefs, columns: { ...prefs.columns, [column.key]: event.target.checked } })}
                    />{" "}
                    {column.label}
                  </label>
                ))}
              </div>
              <button type="button" className="btn-link small" onClick={() => updatePrefs({ ...prefs, columns: {} })}>Reset to default</button>
            </Popover>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            aria-label="Compact rows"
            aria-pressed={Boolean(prefs.dense)}
            title="Toggle row density"
            onClick={() => updatePrefs({ ...prefs, dense: !prefs.dense })}
          >
            <Icon name="rows" />
          </button>
        </div>
      ) : null}
      {chips.length ? (
        <div className="dt-chips">
          {chips}
          <button type="button" className="btn-link small" onClick={() => { setFilterState({}); setPage(0); }}>Clear all</button>
        </div>
      ) : null}
      <div className="tbl-scroll">
        <table className={prefs.dense ? "tbl dense" : "tbl"} aria-label={label}>
          <thead>
            <tr>
              {visibleColumns.map((column) => {
                const active = sort?.[0] === column.key;
                const classes = [column.numeric ? "num" : "", column.compare ? "sortable" : "", column.sticky ? "sticky-col" : "", column.stickyRight ? "sticky-r" : "", column.headerClassName ?? ""].filter(Boolean).join(" ");
                return (
                  <th
                    key={column.key}
                    scope="col"
                    className={classes || undefined}
                    aria-sort={column.compare ? (active ? (sort?.[1] === "asc" ? "ascending" : "descending") : "none") : undefined}
                    style={column.minWidth ? { minWidth: column.minWidth } : undefined}
                  >
                    {column.compare ? (
                      <button
                        type="button"
                        className="th-sort"
                        onClick={() => {
                          setSort(active && sort?.[1] === "asc" ? [column.key, "desc"] : active ? [column.key, "asc"] : [column.key, column.numeric ? "desc" : "asc"]);
                          setPage(0);
                        }}
                      >
                        {column.label}
                        <span className="sort" aria-hidden="true">{active ? (sort?.[1] === "asc" ? "▲" : "▼") : ""}</span>
                      </button>
                    ) : (
                      column.label || <span className="sr-only">Actions</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.length ? (
              pageRows.map((row) => (
                <tr
                  key={rowKey(row)}
                  className={onRowClick ? "row-click" : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  aria-label={onRowClick && props.rowLabel ? props.rowLabel(row) : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (event) => {
                    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      onRowClick(row);
                    }
                  } : undefined}
                >
                  {visibleColumns.map((column) => (
                    <td key={column.key} className={[column.numeric ? "num" : "", column.sticky ? "sticky-col" : "", column.stickyRight ? "sticky-r" : "", column.className ?? ""].filter(Boolean).join(" ") || undefined}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={visibleColumns.length}>
                  <div className="dt-empty">{filtered ? "No results match." : props.empty ?? "No results match."}</div>
                </td>
              </tr>
            )}
            {pinned ? pinned({ columns: visibleColumns, rows: shown, filtered }) : null}
          </tbody>
        </table>
      </div>
      {paginate ? (
        <div className="dt-pager">
          <span>
            Showing <b>{total ? start + 1 : 0}</b> to <b>{Math.min(start + pageSize, total)}</b> of <b>{total}</b> results
          </span>
          <span className="spacer" />
          <label className="small muted">
            Rows{" "}
            <select
              value={pageSize}
              onChange={(event) => {
                updatePrefs({ ...prefs, pageSize: Number(event.target.value) });
                setPage(0);
              }}
            >
              {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <button type="button" className="btn btn-ghost btn-sm" disabled={current <= 0} onClick={() => setPage(current - 1)}>Previous</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</button>
        </div>
      ) : null}
    </div>
  );
}

function FilterControl<T>({ filter, value, onChange }: { filter: Filter<T>; value: FilterState[string]; onChange: (value: FilterState[string]) => void }) {
  if (filter.type === "multi") {
    const values = Array.isArray(value) ? value : [];
    return (
      <fieldset className="fld">
        <legend className="lbl">{filter.label}</legend>
        <div className="checks">
          {filter.options.map(([key, text]) => (
            <label key={key}>
              <input
                type="checkbox"
                className="cb"
                checked={values.includes(key)}
                onChange={(event) => onChange(event.target.checked ? [...values, key] : values.filter((item) => item !== key))}
              />{" "}
              {text}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  if (filter.type === "daterange") {
    const range = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return (
      <fieldset className="fld">
        <legend className="lbl">{filter.label}</legend>
        <div className="row">
          <input type="date" className="inp" aria-label={`${filter.label} from`} value={range.from ?? ""} onChange={(event) => onChange({ ...range, from: event.target.value || undefined })} />
          <input type="date" className="inp" aria-label={`${filter.label} to`} value={range.to ?? ""} onChange={(event) => onChange({ ...range, to: event.target.value || undefined })} />
        </div>
      </fieldset>
    );
  }
  return (
    <div className="fld">
      <label>
        {filter.label}
        <select className="inp" value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || undefined)}>
          <option value="">Any</option>
          {filter.options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
        </select>
      </label>
    </div>
  );
}
