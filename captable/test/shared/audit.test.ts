import { describe, expect, it } from "vitest";
import { auditActor } from "../../src/app/lib/audit.ts";
import { api } from "../../src/app/shared/index.ts";

const BASE = {
  id: 1,
  occurredAt: Date.UTC(2026, 9, 21),
  orgId: null,
  actor: { kind: "import", userId: null, email: null, authMethod: null },
  action: "import.recorded",
  targetType: null,
  targetId: null,
  result: "success",
  reason: null,
  ip: null,
  userAgent: null,
} as const;

function event(details: Record<string, unknown> | null): api.AuditEvent {
  return api.auditEventSchema.parse({ ...BASE, details });
}

describe("audit import actors", () => {
  it("uses a declared or described source and stays neutral when the source is unknown", () => {
    expect(auditActor(event({ source: "template" }), String)).toBe("Imported from the spreadsheet");
    expect(auditActor(event({ summary: "Pulley import recorded" }), String)).toBe("Imported from Pulley");
    expect(auditActor(event(null), String)).toBe("Imported");
  });
});
