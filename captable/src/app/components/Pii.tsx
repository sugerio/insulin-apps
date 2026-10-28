import { useWorkspace } from "./OrgWorkspace.tsx";

// Personal data on screen: shown when /api/me says the caller may see it (owners, admins and editors may), masked
// otherwise. The server masks it already; masking here as well keeps a server slip off the screen.

const MASK = "•";

/** "d•••@mailbox.example". An address the server already masked is left as it is. */
export function maskEmail(email: string): string {
  if (email.includes(MASK)) return email;
  const at = email.lastIndexOf("@");
  if (at <= 0) return `${MASK}${MASK}${MASK}`;
  return `${email[0]}${MASK.repeat(3)}${email.slice(at)}`;
}

export const MASKED_TEXT = "•••• (masked)";

export function usePii() {
  const { canSeePii } = useWorkspace();
  return {
    canSeePii,
    email: (value: string | null | undefined) => (value ? (canSeePii ? value : maskEmail(value)) : "—"),
    text: (value: string | null | undefined) => (value ? (canSeePii ? value : MASKED_TEXT) : canSeePii ? "—" : MASKED_TEXT),
  };
}
