import { useId, useMemo, useState, type ReactNode } from "react";
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, ChevronsUpDownIcon, Columns3Icon, FilterIcon, Rows3Icon, SearchIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field.tsx";
import { Input } from "@/components/ui/input.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group.tsx";
import { Label } from "@/components/ui/label.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { Toggle } from "@/components/ui/toggle.tsx";
import { cn } from "@/lib/utils.ts";
import { useAuth } from "../auth/AuthProvider.tsx";
import { compareDecimals, compareRatios } from "../lib/decimal.ts";
import { formatDate } from "../lib/format.ts";

// The list table, on shadcn/ui's Table: a search box, Filters (a popover; active filters show as removable chips),
// Columns (a checkbox list with per-table defaults, remembered per user), a density toggle, sortable headers, and
// "Showing a to b of N results" with Previous/Next and a page-size menu. Lists come whole from the API, so all of this
// runs in the browser.

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

/**
 * The classes of a column's cells, for rows a caller draws itself (the cap table's pinned "Available pool" and
 * "Totals"): numbers right-aligned in tabular figures, sticky columns kept in view while the table scrolls sideways.
 */
export function columnCellClassName<T>(column: Pick<Column<T>, "numeric" | "sticky" | "stickyRight" | "className">): string {
  return cn(
    column.numeric && "text-right tabular-nums",
    column.sticky && "sticky left-0 z-10 bg-background",
    column.stickyRight && "sticky right-0 z-10 bg-background",
    column.className,
  );
}

/** A toolbar popover (Filters, Columns): it closes with Done, Escape or a click outside, and gives focus back. */
function ToolbarPopover({ label, count, icon, children }: { label: string; count?: number; icon: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {icon} {label}
          {count ? <Badge variant="secondary">{count}</Badge> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label={label} className="w-72">
        <PopoverHeader>
          <PopoverTitle>{label}</PopoverTitle>
        </PopoverHeader>
        {children}
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={() => setOpen(false)}>Done</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A labelled checkbox of a toolbar popover's list. */
function CheckItem({ label, checked, onChange }: { label: ReactNode; checked: boolean; onChange: (checked: boolean) => void }) {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <FieldLabel htmlFor={id} className="font-normal">{label}</FieldLabel>
    </Field>
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
  const rowsId = useId();
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
  const clearFilters = () => {
    setFilterState({});
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
      <Badge variant="secondary" className="h-6 gap-1 pr-1" key={filter.key}>
        {filter.label}: {text}
        <Button type="button" variant="ghost" size="icon-xs" className="size-4 rounded-full" aria-label={`Remove filter ${filter.label}`} onClick={() => setFilter(filter.key, undefined)}>
          <XIcon />
        </Button>
      </Badge>,
    ];
  });

  return (
    <div className="flex flex-col gap-3">
      {toolbar ? (
        <div className="flex flex-wrap items-center gap-2">
          {search ? (
            <InputGroup className="w-full sm:max-w-xs">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                aria-label={`Search ${label.toLowerCase()}`}
                value={query}
                placeholder={props.searchPlaceholder ?? "Search…"}
                autoComplete="off"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
            </InputGroup>
          ) : null}
          <div className="flex-1" />
          {props.toolbarExtra}
          {filters.length ? (
            <ToolbarPopover label="Filters" icon={<FilterIcon />} count={Object.values(filterState).filter(isActive).length}>
              <FieldGroup className="gap-4">
                {filters.map((filter) => (
                  <FilterControl key={filter.key} filter={filter} value={filterState[filter.key]} onChange={(value) => setFilter(filter.key, value)} />
                ))}
              </FieldGroup>
              <Button type="button" variant="ghost" size="sm" className="self-start" onClick={clearFilters}>Clear</Button>
            </ToolbarPopover>
          ) : null}
          {hasOptional ? (
            <ToolbarPopover label="Columns" icon={<Columns3Icon />}>
              <FieldGroup className="gap-2">
                {choosable.map((column) => (
                  <CheckItem
                    key={column.key}
                    label={column.label}
                    checked={visibleColumns.includes(column)}
                    onChange={(checked) => updatePrefs({ ...prefs, columns: { ...prefs.columns, [column.key]: checked } })}
                  />
                ))}
              </FieldGroup>
              <Button type="button" variant="link" size="sm" className="self-start px-0" onClick={() => updatePrefs({ ...prefs, columns: {} })}>Reset to default</Button>
            </ToolbarPopover>
          ) : null}
          <Toggle
            variant="outline"
            size="sm"
            aria-label="Compact rows"
            title="Toggle row density"
            pressed={Boolean(prefs.dense)}
            onPressedChange={(pressed) => updatePrefs({ ...prefs, dense: pressed })}
          >
            <Rows3Icon />
          </Toggle>
        </div>
      ) : null}
      {chips.length ? (
        <div className="flex flex-wrap items-center gap-2">
          {chips}
          <Button type="button" variant="link" size="sm" className="px-0" onClick={clearFilters}>Clear all</Button>
        </div>
      ) : null}
      <div className="overflow-hidden rounded-lg border">
        <Table aria-label={label} data-density={prefs.dense ? "compact" : "comfortable"} className={cn(prefs.dense && "[&_td]:py-1 [&_th]:h-8")}>
          <TableHeader className="bg-muted/50">
            <TableRow>
              {visibleColumns.map((column) => {
                const active = sort?.[0] === column.key;
                return (
                  <TableHead
                    key={column.key}
                    scope="col"
                    className={cn(
                      column.numeric && "text-right",
                      column.sticky && "sticky left-0 z-10 bg-muted",
                      column.stickyRight && "sticky right-0 z-10 bg-muted",
                      column.headerClassName,
                    )}
                    aria-sort={column.compare ? (active ? (sort?.[1] === "asc" ? "ascending" : "descending") : "none") : undefined}
                    style={column.minWidth ? { minWidth: column.minWidth } : undefined}
                  >
                    {column.compare ? (
                      <button
                        type="button"
                        className={cn(
                          "inline-flex items-center gap-1 rounded-sm font-medium outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
                          column.numeric && "flex-row-reverse",
                        )}
                        onClick={() => {
                          setSort(active && sort?.[1] === "asc" ? [column.key, "desc"] : active ? [column.key, "asc"] : [column.key, column.numeric ? "desc" : "asc"]);
                          setPage(0);
                        }}
                      >
                        {column.label}
                        {active ? (
                          sort?.[1] === "asc" ? <ArrowUpIcon className="size-3.5" /> : <ArrowDownIcon className="size-3.5" />
                        ) : (
                          <ChevronsUpDownIcon className="size-3.5 text-muted-foreground/60" />
                        )}
                      </button>
                    ) : (
                      column.label || <span className="sr-only">Actions</span>
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.length ? (
              pageRows.map((row) => (
                <TableRow
                  key={rowKey(row)}
                  className={onRowClick ? "cursor-pointer outline-none focus-visible:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50" : undefined}
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
                    <TableCell key={column.key} className={columnCellClassName(column) || undefined}>
                      {column.render(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={visibleColumns.length} className="h-24 text-center whitespace-normal text-muted-foreground">
                  {filtered ? "No results match." : props.empty ?? "No results match."}
                </TableCell>
              </TableRow>
            )}
            {pinned ? pinned({ columns: visibleColumns, rows: shown, filtered }) : null}
          </TableBody>
        </Table>
      </div>
      {paginate ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>
            Showing <b className="font-medium text-foreground">{total ? start + 1 : 0}</b> to <b className="font-medium text-foreground">{Math.min(start + pageSize, total)}</b> of{" "}
            <b className="font-medium text-foreground">{total}</b> results
          </span>
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <Label htmlFor={rowsId} className="font-normal text-muted-foreground">Rows</Label>
            <NativeSelect
              id={rowsId}
              size="sm"
              value={pageSize}
              onChange={(event) => {
                updatePrefs({ ...prefs, pageSize: Number(event.target.value) });
                setPage(0);
              }}
            >
              {PAGE_SIZES.map((size) => <NativeSelectOption key={size} value={size}>{size}</NativeSelectOption>)}
            </NativeSelect>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={current <= 0} onClick={() => setPage(current - 1)}>
            <ChevronLeftIcon /> Previous
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
            Next <ChevronRightIcon />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FilterControl<T>({ filter, value, onChange }: { filter: Filter<T>; value: FilterState[string]; onChange: (value: FilterState[string]) => void }) {
  const id = useId();
  if (filter.type === "multi") {
    const values = Array.isArray(value) ? value : [];
    return (
      <FieldSet className="gap-2">
        <FieldLegend variant="label">{filter.label}</FieldLegend>
        <FieldGroup className="gap-2">
          {filter.options.map(([key, text]) => (
            <CheckItem
              key={key}
              label={text}
              checked={values.includes(key)}
              onChange={(checked) => onChange(checked ? [...values, key] : values.filter((item) => item !== key))}
            />
          ))}
        </FieldGroup>
      </FieldSet>
    );
  }
  if (filter.type === "daterange") {
    const range = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return (
      <FieldSet className="gap-2">
        <FieldLegend variant="label">{filter.label}</FieldLegend>
        <div className="grid grid-cols-2 gap-2">
          <Input type="date" aria-label={`${filter.label} from`} value={range.from ?? ""} onChange={(event) => onChange({ ...range, from: event.target.value || undefined })} />
          <Input type="date" aria-label={`${filter.label} to`} value={range.to ?? ""} onChange={(event) => onChange({ ...range, to: event.target.value || undefined })} />
        </div>
      </FieldSet>
    );
  }
  return (
    <Field>
      <FieldLabel htmlFor={id}>{filter.label}</FieldLabel>
      <NativeSelect id={id} className="w-full" value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || undefined)}>
        <NativeSelectOption value="">Any</NativeSelectOption>
        {filter.options.map(([key, text]) => <NativeSelectOption key={key} value={key}>{text}</NativeSelectOption>)}
      </NativeSelect>
    </Field>
  );
}
