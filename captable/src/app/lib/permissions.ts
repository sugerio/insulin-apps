// Who sees which write affordance. The rules:
// - Editors see no write buttons and a "Read-only" badge next to the H1; the UI hides what the API would refuse.
// - No admin sees write actions on their own holdings or stakeholder record: pages and rows about them sit
//   in an OwnRecordScope, which hides every write affordance inside. Entry points that aren't about one holding (the
//   cap table's Actions, "+ New") stay; the flows behind them must leave the admin's own holdings and record out of
//   what they offer, and the server refuses them anyway (403 self_dealing).
// - Every write affordance leads to its flow: an Actions item has `onSelect` or `to`, a WriteButton `onClick` or `to`
//   (their types require one). One that can't be used just now is disabled with its reason.

export interface WriteAccess {
  canWrite: boolean;
}

/** Whether a write affordance is shown at all: owners and admins see it, editors don't. */
export function showsWrite(access: WriteAccess): boolean {
  return access.canWrite;
}
