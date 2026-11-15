import { engine, type api } from "#shared";

// 83(b) records. A record is never changed: a correction is a new record that supersedes the old one, so the record in
// force is found by supersession, as the holder view and the raw export read it, never by list order.

/** Each share's record in force: the latest record that no other record supersedes. */
export function electionsInForce(records: readonly api.Election83b[]): Map<string, api.Election83b> {
  const superseded = new Set(records.map((record) => record.supersedesId).filter((id): id is string => id !== null));
  const inForce = new Map<string, api.Election83b>();
  for (const record of records) {
    if (superseded.has(record.id)) continue;
    const other = inForce.get(record.securityId);
    if (!other || record.createdAt > other.createdAt || (record.createdAt === other.createdAt && record.id > other.id)) inForce.set(record.securityId, record);
  }
  return inForce;
}

/** The election deadline: 30 days after the transfer, rolled to the next business day (IRC §7503); else the record's. */
export function electionDueDate(record: Pick<api.Election83b, "transferDate" | "dueDate">): string | null {
  return record.transferDate ? engine.election83bDeadline(record.transferDate).date : record.dueDate;
}
