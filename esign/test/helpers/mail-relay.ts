// Plays the hosting platform's mail relay (src/app/server/esign/mail.ts) for tests: the bindings
// that point Esign at it, and every message it was asked to send. It answers `status()`: 202 once
// sent, or the relay's refusals (502 `send_failed`, 503 while unavailable, 429 over a limit).

export type RelayedMail = { url: string; headers: Headers; body: { to: string; subject: string; text: string } };

export const RELAY_URL = 'https://mail.example.test/v1/send';

export function mailRelay(status: () => number = () => 202) {
  const sent: RelayedMail[] = [];
  const env = {
    SUGER_MAIL_URL: RELAY_URL,
    SUGER_APP_TOKEN: 'synthetic-app-token',
    MAIL_FETCH: (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      const code = status();
      if (code === 202) return Response.json({ id: crypto.randomUUID() }, { status: 202 });
      return Response.json({ error: code === 502 ? 'send_failed' : code === 429 ? 'rate_limited' : 'unavailable' }, { status: code });
    }) as typeof fetch,
  };
  return { sent, env };
}
