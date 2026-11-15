import { useSearchParams } from "react-router";
import { CircleHelpIcon } from "lucide-react";
import type { api } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { ProgressBar } from "../../components/Charts.tsx";
import { useDisplay } from "../../components/Display.tsx";
import { Banner, NotFoundState, Pending } from "../../components/Feedback.tsx";
import { Card } from "../../components/Page.tsx";
import { DocumentCards, ExecutionBadge, PortalLink, PortalPage, StatusBadge } from "../../components/PortalParts.tsx";
import { usePortal } from "../../components/PortalWorkspace.tsx";
import { Tiles, type Tile } from "../../components/Tiles.tsx";
import { DASH, formatDate, formatDaysLeft, plural } from "../../lib/format.ts";
import { SECURITY_STATUS_LABELS } from "../../lib/labels.ts";
import { awaitingHolderSignature, exitWindows, isPositive, securityPath, summarize, typeLabel, upcomingVests, type ExitWindow } from "../../lib/portal.ts";
import { useResource } from "../../lib/useResource.ts";

/** A link inside running text. */
const TEXT_LINK = "font-medium underline underline-offset-4";
/** A number in a table cell. */
const NUM = "text-right tabular-nums whitespace-nowrap";

// Portfolio: the exit-window banner for former employees, tiles,
// vesting status, the next vest events, the holder's grants and shares, and company resources. Read-only. (`/portfolio`
// itself leads here through the router's navigation paths.)

/** `/portfolio/:orgId` (and the admin preview's index). */
export function PortfolioOverviewPage() {
  const portal = usePortal();
  const [params] = useSearchParams();
  const record = portal.holdings.find((holding) => holding.stakeholderId === params.get("holder")) ?? portal.holdings[0]!;
  return (
    <PortalPage title={portal.preview ? portal.preview.stakeholderName : "Portfolio"}>
      <Overview record={record} />
    </PortalPage>
  );
}

function Overview({ record }: { record: api.PortalHolding }) {
  const portal = usePortal();
  const { format, today } = useDisplay();
  const securities = record.securities;
  const summary = summarize(securities);
  const windows = exitWindows(securities, today);
  const upcoming = upcomingVests(securities);
  const restricted = securities.filter((security) => security.family === "STOCK" && security.vesting.length > 0 && isPositive(security.numbers.unvested));
  const hasVesting = summary.options !== null || restricted.length > 0;

  const tiles: Tile[] = [
    ...summary.sharesByClass.map((entry) => ({
      label: entry.className,
      value: format.shares(entry.quantity),
      sub: entry.records.length === 1 ? entry.records[0]!.displayId : `${entry.records.length} records`,
    })),
    ...(summary.options
      ? [{ label: "Options", value: format.shares(summary.options.outstanding), sub: `${format.shares(summary.options.vestedUnexercised)} vested and unexercised · ${format.shares(summary.options.unvested)} unvested` }]
      : []),
    ...(summary.warrants ? [{ label: "Warrants", value: format.shares(summary.warrants) }] : []),
    ...(summary.safes.length ? [{ label: "SAFEs", value: plural(summary.safes.length, "SAFE"), sub: statusCounts(summary.safes) }] : []),
  ];
  if (tiles.length === 0) tiles.push({ label: "Holdings", value: "None outstanding" });

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end gap-2" data-portfolio-hero="">
          <div className="flex-1">
            <div className="text-xs text-muted-foreground">Portfolio</div>
            <h1 className="text-2xl font-semibold tracking-tight">{portal.orgName}</h1>
          </div>
          <div className="text-xs text-muted-foreground">{record.stakeholderName}</div>
        </div>
        <RecordSwitcher current={record.stakeholderId} />
      </Card>
      {windows.length ? <ExitWindowBanner windows={windows} /> : null}
      <Tiles items={tiles} label="Holdings summary" />
      {hasVesting ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Vesting status">
            <p className="text-xs text-muted-foreground">
              Your equity vests over time, on the schedule in your grant agreement. Exercising an option means buying its shares at
              the exercise price: you can exercise vested options until they expire or, if you leave, until your exercise
              deadline. <PortalLink className={TEXT_LINK} to="how-to-exercise">How to exercise</PortalLink> explains the steps.
            </p>
            {summary.options ? (
              <div>
                <div className="mb-2 text-xs text-muted-foreground">Options</div>
                {isPositive(summary.options.vestedUnexercised) || isPositive(summary.options.unvested) || isPositive(summary.options.cancelled) ? (
                  <ProgressBar vested={summary.options.vestedUnexercised} unvested={summary.options.unvested} cancelled={summary.options.cancelled} unit="options" vestedLabel="Vested and unexercised" />
                ) : (
                  <p className="text-xs text-muted-foreground">No options left to vest or exercise.</p>
                )}
              </div>
            ) : null}
            {restricted.length ? (
              <div>
                <div className="mb-2 text-xs text-muted-foreground">Restricted shares</div>
                {restricted.map((security) => (
                  <div className="text-xs tabular-nums" key={security.id}>
                    {security.displayId}: <b>{format.shares(security.numbers.vested)}</b> vested · <b>{format.shares(security.numbers.unvested)}</b> unvested
                  </div>
                ))}
              </div>
            ) : null}
          </Card>
          <Card title="Upcoming vest events">
            {upcoming.length ? (
              <Table aria-label="Upcoming vest events">
                <TableHeader><TableRow><TableHead scope="col">Date</TableHead><TableHead scope="col">Event</TableHead></TableRow></TableHeader>
                <TableBody>
                  {upcoming.map((event) => (
                    <TableRow key={`${event.security.id}-${event.date}`}>
                      <TableCell className="whitespace-nowrap">{formatDate(event.date)}</TableCell>
                      <TableCell className="whitespace-normal">{format.shares(event.quantity)} {event.unit} ({event.security.displayId}) vest</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">No upcoming vesting events.</p>
            )}
          </Card>
        </div>
      ) : null}
      <Card title="My grants and shares">
        <GrantsTable securities={securities} />
      </Card>
      <CompanyResources />
    </>
  );
}

/**
 * The exit-window banner: "You can exercise 60,000 vested options until Feb 28, 2027. Exercises after
 * Nov 30, 2026 are taxed as NSOs." One statement per set of grants sharing both deadlines, so a quantity is never
 * labelled with another grant's date; the grants are named whenever more than one is open. A passed ISO deadline stays
 * visible while the contractual window is open: from then on every exercise is taxed as an NSO. A grant awaiting the
 * holder's own signature is never called exercisable: its statement says the signature comes first, and gives its date.
 */
function ExitWindowBanner({ windows }: { windows: readonly ExitWindow[] }) {
  const { format, today } = useDisplay();
  const named = windows.length > 1 || windows[0]!.grants.length > 1;
  const statement = (window: ExitWindow) => {
    const grants = named ? ` (${window.grants.map((grant) => grant.displayId).join(", ")})` : "";
    const iso = window.iso.kind === "upcoming"
      ? ` Exercises after ${formatDate(window.iso.date)} (${formatDaysLeft(today, window.iso.date)}) are taxed as NSOs.`
      : window.iso.kind === "passed"
        ? ` The ISO deadline passed on ${formatDate(window.iso.date)}: exercises from now on are taxed as NSOs.`
        : "";
    const until = `${formatDate(window.deadline)} (${formatDaysLeft(today, window.deadline)})`;
    if (window.awaitingSignature) {
      return `Your signature is still needed on ${window.grants[0]!.displayId} before you can exercise its ${format.shares(window.quantity)} vested options. Its exercise window closes on ${until}.${iso}`;
    }
    return `You can exercise ${format.shares(window.quantity)} vested options${grants} until ${until}.${iso}`;
  };
  const how = <>Read <PortalLink className={TEXT_LINK} to="how-to-exercise">How to exercise</PortalLink> — exercising is an offline process.</>;
  if (windows.length === 1) return <Banner kind="warn" title={statement(windows[0]!)}>{how}</Banner>;
  const title = windows.some((window) => window.awaitingSignature) ? "Your exercise deadlines:" : "You can exercise vested options before these deadlines:";
  return (
    <Banner kind="warn" title={title}>
      <ul className="my-1 list-disc space-y-1 pl-5">
        {windows.map((window) => <li key={window.grants.map((grant) => grant.id).join()}>{statement(window)}</li>)}
      </ul>
      {how}
    </Banner>
  );
}

/** "1 outstanding · 1 converted": how many of the securities are in each status, in the labels' order. */
function statusCounts(securities: readonly api.PortalSecurity[]): string {
  return (Object.keys(SECURITY_STATUS_LABELS) as api.PortalSecurity["status"][])
    .map((status) => [status, securities.filter((security) => security.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count.toLocaleString("en-US")} ${SECURITY_STATUS_LABELS[status].toLowerCase()}`)
    .join(" · ");
}

/** "You hold equity under 2 records" (an individual and their trust are separate stakeholders). */
function RecordSwitcher({ current }: { current: string }) {
  const portal = usePortal();
  const [params, setParams] = useSearchParams();
  if (portal.holdings.length < 2) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Your records">
      <span className="text-muted-foreground">You hold equity under {portal.holdings.length} records:</span>
      {portal.holdings.map((holding) => (
        <Button
          key={holding.stakeholderId}
          type="button"
          size="xs"
          variant={holding.stakeholderId === current ? "default" : "ghost"}
          aria-pressed={holding.stakeholderId === current}
          onClick={() => {
            const next = new URLSearchParams(params);
            next.set("holder", holding.stakeholderId);
            setParams(next);
          }}
        >
          {holding.stakeholderName}
        </Button>
      ))}
    </div>
  );
}

/**
 * The Exercisable column: options and warrants exercisable now, or that the holder's own signature
 * comes first; a dash for shares and SAFEs. An option grant with options to exercise links to How to exercise.
 */
function ExercisableCell({ security }: { security: api.PortalSecurity }) {
  const { format } = useDisplay();
  if (security.family !== "EQUITY_COMPENSATION" && security.family !== "WARRANT") return <TableCell className={NUM}>{DASH}</TableCell>;
  if (awaitingHolderSignature(security)) return <TableCell className={`${NUM} text-muted-foreground`}>Awaiting your signature</TableCell>;
  const exercisable = security.numbers.exercisable;
  return (
    <TableCell className={NUM}>
      {format.shares(exercisable)}
      {security.family === "EQUITY_COMPENSATION" && security.status === "OUTSTANDING" && isPositive(exercisable) ? (
        <div className="text-xs">
          <PortalLink className={TEXT_LINK} to={`how-to-exercise?grant=${security.id}`}>How to exercise <span className="sr-only">for {security.displayId}</span></PortalLink>
        </div>
      ) : null}
    </TableCell>
  );
}

function GrantsTable({ securities }: { securities: readonly api.PortalSecurity[] }) {
  const { format } = useDisplay();
  if (securities.length === 0) return <p className="text-sm text-muted-foreground">No grants or shares.</p>;
  const ordered = [...securities].sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.displayId.localeCompare(b.displayId, undefined, { numeric: true }));
  const vestedOf = (security: api.PortalSecurity) => {
    if (security.family === "CONVERTIBLE") return null;
    if (security.family === "WARRANT") return security.numbers.outstanding;
    return security.numbers.vested;
  };
  return (
    <Table aria-label="My grants and shares">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">ID</TableHead>
          <TableHead scope="col">Type</TableHead>
          <TableHead scope="col">Status</TableHead>
          <TableHead scope="col">Grant / issue date</TableHead>
          <TableHead scope="col">Expiration</TableHead>
          <TableHead scope="col" className="text-right">Quantity</TableHead>
          <TableHead scope="col" className="text-right">Vested</TableHead>
          <TableHead scope="col" className="text-right">Exercisable</TableHead>
          <TableHead scope="col" className="text-right">Exercise price</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ordered.map((security) => (
          <TableRow key={security.id}>
            <TableCell><PortalLink className="font-medium tabular-nums underline-offset-4 hover:underline" to={securityPath(security)}>{security.displayId}</PortalLink></TableCell>
            <TableCell>{typeLabel(security)}</TableCell>
            <TableCell>
              <span className="flex flex-wrap gap-1">
                <StatusBadge status={security.status} />
                {security.executionPending ? <> <ExecutionBadge security={security} /></> : null}
              </span>
            </TableCell>
            <TableCell>{formatDate(security.issueDate)}</TableCell>
            <TableCell>{formatDate(security.expirationDate)}</TableCell>
            <TableCell className={NUM}>{security.family === "CONVERTIBLE" ? DASH : format.shares(security.numbers.granted ?? security.numbers.outstanding)}</TableCell>
            <TableCell className={NUM}>{format.shares(vestedOf(security))}</TableCell>
            <ExercisableCell security={security} />
            <TableCell className={NUM}>{security.family === "EQUITY_COMPENSATION" || security.family === "WARRANT" ? format.price(security.exercisePrice) : DASH}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The company resources every holder may open (plan, counsel's notice form, FAQ, privacy notice) and How to exercise. */
function CompanyResources() {
  const portal = usePortal();
  const documents = useResource((signal) => portal.source.documents(signal), [portal.source.key]);
  return (
    <Card title="Company resources">
      <Item variant="outline" size="sm">
        <ItemMedia>
          <CircleHelpIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>
            <PortalLink className="font-medium underline-offset-4 hover:underline" to="how-to-exercise">How to exercise your options</PortalLink>
          </ItemTitle>
        </ItemContent>
      </Item>
      <Pending resource={documents} what="the company resources">
        {(data) => <DocumentCards documents={data.filter((document) => document.scope === "company")} empty="No company resources yet." />}
      </Pending>
    </Card>
  );
}


/** A portal address that doesn't exist. */
export function PortalNotFoundPage() {
  const portal = usePortal();
  return (
    <PortalPage title="Not found">
      <NotFoundState message="This page isn't in your portfolio." back={{ to: portal.href(), label: "Back to portfolio" }} />
    </PortalPage>
  );
}
