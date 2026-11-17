import { drizzle } from "drizzle-orm/d1";
import { migrate } from "drizzle-orm/d1/migrator";
import { resolve } from "node:path";
import { createApp, type AppOptions } from "../../src/app/server/app.ts";
import { type LocalD1, openLocalD1 } from "../../src/local-d1.ts";

// The real server against a fresh in-memory D1 (src/local-d1.ts: foreign keys on, `batch()` atomic), with every
// migration applied the way the preview applies them. Requests carry the platform's identity headers, as the gateway
// sends them.

export const MIGRATIONS_FOLDER = resolve(import.meta.dirname, "../../src/app/db/migrations");
export const ORIGIN = "http://app.test";

export async function openMigratedDatabase(): Promise<LocalD1> {
  const database = await openLocalD1(":memory:");
  await migrate(drizzle(database), { migrationsFolder: MIGRATIONS_FOLDER });
  return database;
}

export interface Identity {
  userId?: string;
  orgId?: string;
  role?: "OWNER" | "ADMIN" | "EDITOR" | "USER" | "VIEWER";
  /** `x-suger-app-permissions`, space-separated, as the platform sends it for a custom role. */
  permissions?: string;
  via?: string;
  name?: string;
}

export const OWNER: Identity = { userId: "user-owner", orgId: "org-a", role: "OWNER", name: "Avery Owner" };
export const VIEWER: Identity = { userId: "user-viewer", orgId: "org-a", role: "VIEWER", name: "Vic Viewer" };
export const OTHER_ORG: Identity = { userId: "user-other", orgId: "org-b", role: "OWNER", name: "Olive Other" };

export function identityHeaders(identity: Identity): Record<string, string> {
  return {
    "x-suger-user-id": identity.userId ?? "user-owner",
    "x-suger-organization-id": identity.orgId ?? "org-a",
    "x-suger-app-id": "app-personal-tax",
    "x-suger-app-role": identity.role ?? "OWNER",
    "x-suger-user-email": `${identity.userId ?? "user"}@example.test`,
    "x-suger-user-name": identity.name ?? "Test Person",
    ...(identity.permissions === undefined ? {} : { "x-suger-app-permissions": identity.permissions }),
    ...(identity.via === undefined ? {} : { "x-suger-access-via": identity.via }),
  };
}

export interface TestServer {
  db: LocalD1;
  app: ReturnType<typeof createApp>;
  /** Sends a request as `identity` (null: no identity), with a JSON body when given. */
  call(method: string, path: string, options?: { as?: Identity | null; body?: unknown; headers?: Record<string, string> }): Promise<Response>;
  close(): void;
}

export async function startServer(options: AppOptions = {}): Promise<TestServer> {
  const db = await openMigratedDatabase();
  const app = createApp({ enforceSameOrigin: true, ...options });
  return {
    db,
    app,
    call(method, path, { as = OWNER, body, headers = {} } = {}) {
      return Promise.resolve(
        app.fetch(
          new Request(`${ORIGIN}${path}`, {
            method,
            headers: {
              ...(as ? identityHeaders(as) : {}),
              ...(method === "GET" ? {} : { Origin: ORIGIN }),
              ...(body === undefined ? {} : { "Content-Type": "application/json" }),
              ...headers,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
          { DB: db },
        ),
      );
    },
    close: () => db.close(),
  };
}
