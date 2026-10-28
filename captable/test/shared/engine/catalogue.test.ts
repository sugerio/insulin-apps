import { describe, expect, it } from "vitest";
import {
  isTransactionType,
  PAYLOAD_SCHEMAS,
  securityFamilyOf,
  TRANSACTION_TYPE_CODES,
  TRANSACTION_TYPES,
  transactionTypeInfo,
} from "../../../src/app/shared/engine/index.ts";
import { OCF_COMMIT_SHA, OCF_SCHEMA_ID_PREFIX, OCF_TAG, OCF_TRANSACTION_SCHEMAS, OCF_VERSION, ocfKeyViolations } from "../../../src/app/shared/ocf/index.ts";
import { z } from "zod";

interface OcfSchema {
  $id: string;
  $comment?: string;
  properties?: Record<string, { const?: string; enum?: string[] }>;
  additionalProperties?: boolean;
}

const vendored = import.meta.glob<OcfSchema>("../../../src/app/shared/ocf/schema/**/*.json", { eager: true, import: "default" });

describe("the transaction catalogue", () => {
  it("names OCF types TX_ and extensions X_", () => {
    for (const type of TRANSACTION_TYPES) expect(type.code.startsWith("TX_")).toBe(type.isOcf);
    expect(isTransactionType("TX_STOCK_ISSUANCE")).toBe(true);
    expect(isTransactionType("TX_PLAN_SECURITY_ISSUANCE")).toBe(false);
    expect(isTransactionType(42)).toBe(false);
    expect(transactionTypeInfo("X_REVERSAL").family).toBe("LEDGER");
    expect(securityFamilyOf("TX_WARRANT_EXERCISE")).toBe("WARRANT");
    expect(securityFamilyOf("TX_STOCK_PLAN_POOL_ADJUSTMENT")).toBeNull();
  });

  it("has a payload schema for every type", () => {
    expect(Object.keys(PAYLOAD_SCHEMAS).sort()).toEqual([...TRANSACTION_TYPE_CODES].sort());
  });
});

describe("the OCF v1.2.0 pin", () => {
  it("records the tag and its commit", () => {
    expect(OCF_VERSION).toBe("1.2.0");
    expect(OCF_TAG).toBe("v1.2.0");
    expect(OCF_COMMIT_SHA).toMatch(/^[0-9a-f]{40}$/);
  });

  it("vendors the tag's schemas unmodified, each with its license comment", () => {
    const files = Object.entries(vendored);
    expect(files).toHaveLength(168);
    for (const [path, schema] of files) {
      const relative = path.replace("../../../src/app/shared/ocf/schema/", "");
      expect(schema.$id, relative).toBe(OCF_SCHEMA_ID_PREFIX + relative);
      expect(schema.$comment, relative).toContain(`Copyright © 2024 Open Cap Table Coalition`);
      expect(schema.$comment, relative).toContain(`/tree/${OCF_TAG}/schema/${relative}`);
    }
  });

  it("lists every OCF transaction type of the catalogue in the vendored ObjectType enum", () => {
    const objectTypes = (vendored["../../../src/app/shared/ocf/schema/enums/ObjectType.schema.json"] as unknown as { enum: string[] }).enum;
    for (const type of TRANSACTION_TYPES.filter((t) => t.isOcf)) expect(objectTypes, type.code).toContain(type.code);
  });

  it("derives the allowed keys from the vendored schemas (no drift)", () => {
    const ocfTypes = TRANSACTION_TYPES.filter((t) => t.isOcf).map((t) => t.code);
    expect(Object.keys(OCF_TRANSACTION_SCHEMAS).sort()).toEqual([...ocfTypes].sort());
    for (const [type, entry] of Object.entries(OCF_TRANSACTION_SCHEMAS)) {
      const schema = vendored[`../../../src/app/shared/ocf/schema/${entry.schema}`];
      expect(schema, type).toBeDefined();
      const objectType = schema!.properties!.object_type!;
      expect([objectType.const, ...(objectType.enum ?? [])], type).toContain(type);
      expect(schema!.additionalProperties, type).toBe(false);
      expect([...entry.keys].sort(), type).toEqual(Object.keys(schema!.properties!).filter((k) => k !== "object_type").sort());
    }
  });

  it("allows only OCF property names and x_ extensions in OCF-typed payloads", () => {
    for (const type of TRANSACTION_TYPES.filter((t) => t.isOcf)) {
      for (const key of payloadKeys(PAYLOAD_SCHEMAS[type.code])) {
        if (key.startsWith("x_")) continue;
        expect(OCF_TRANSACTION_SCHEMAS[type.code as keyof typeof OCF_TRANSACTION_SCHEMAS].keys as readonly string[], `${type.code}.${key}`).toContain(key);
      }
    }
    expect(ocfKeyViolations("TX_STOCK_TRANSFER", { security_id: "x", quantity: "1", x_reason: "GIFT" })).toEqual([]);
    expect(ocfKeyViolations("TX_STOCK_TRANSFER", { security_id: "x", reason: "GIFT" })).toEqual(["reason"]);
    expect(ocfKeyViolations("X_STAKEHOLDER_LEAVE", { anything: 1 })).toEqual([]);
  });
});

/** The keys a payload schema accepts (through refinements and unions). */
function payloadKeys(schema: z.ZodType): string[] {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  if (def.type === "object") return Object.keys((schema as unknown as z.ZodObject).shape);
  if (def.type === "union") return (def.options as z.ZodType[]).flatMap(payloadKeys);
  if (def.type === "pipe") return payloadKeys(def.in as z.ZodType);
  throw new Error(`Unexpected schema type ${String(def.type)}`);
}
