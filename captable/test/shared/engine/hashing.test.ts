import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  chainHash,
  chainInput,
  CHAINED_COLUMNS,
  Dec,
  definitionSha256,
  EngineError,
  genesisHash,
  isCanonicalJsonText,
  payloadSha256,
  payloadText,
  Rational,
  sha256,
  sha256Hex,
  toHex,
  utf8,
  verifyChain,
  type TransactionRow,
} from "../../../src/app/shared/engine/index.ts";
import { LedgerBuilder, uuid } from "./fixtures/builder.ts";

// Room for full replays and property runs on a loaded CI machine (vitest's default is 5 s per test).
const SLOW = { timeout: 30_000 };

async function webCryptoHex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))));
}

describe("canonicalJson", SLOW, () => {
  it("sorts keys, drops whitespace and undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, "x", null, true], c: false }, e: undefined })).toBe('{"a":{"c":false,"d":[1,"x",null,true]},"b":1}');
    expect(canonicalJson("é\n\"")).toBe('"é\\n\\""');
    expect(canonicalJson({ "é": 1, z: 2, A: 3 })).toBe('{"A":3,"z":2,"é":1}');
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson(Object.create(null))).toBe("{}");
  });

  it("serializes decimals and rationals through toJSON", () => {
    expect(canonicalJson({ q: Dec.from("12.50"), r: Rational.of(2, 4) })).toBe('{"q":"12.5","r":"1/2"}');
  });

  it("refuses values two runtimes could serialize differently", () => {
    expect(() => canonicalJson(0.1)).toThrow(/safe integers/);
    expect(() => canonicalJson(Number.NaN)).toThrow(EngineError);
    expect(() => canonicalJson(2 ** 60)).toThrow(EngineError);
    expect(() => canonicalJson(1n)).toThrow(EngineError);
    expect(() => canonicalJson([undefined])).toThrow(/^\$\[0\]: undefined in an array$/);
    expect(() => canonicalJson({ a: [1, { b: 0.5 }] })).toThrow(/^\$\.a\[1\]\.b: only safe integers/);
    expect(() => canonicalJson({ a: { b: new Set() } })).toThrow(/^\$\.a\.b: only plain objects/);
    expect(() => canonicalJson(new Map())).toThrow(/plain objects/);
    expect(() => canonicalJson(() => 1)).toThrow(EngineError);
    expect(() => canonicalJson(undefined)).toThrow(EngineError);
  });

  it("is independent of key order and stable through a round trip", () => {
    const json = fc.letrec((tie) => ({
      value: fc.oneof(
        { depthSize: "small" },
        fc.constant(null),
        fc.boolean(),
        fc.integer(),
        fc.string(),
        fc.array(tie("value"), { maxLength: 4 }),
        fc.dictionary(fc.string({ maxLength: 6 }), tie("value"), { maxKeys: 4 }),
      ),
    })).value;
    fc.assert(
      fc.property(json, (value) => {
        const text = canonicalJson(value);
        expect(canonicalJson(JSON.parse(text))).toBe(text);
        expect(isCanonicalJsonText(text)).toBe(true);
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          const reversed = Object.fromEntries(Object.entries(value).reverse());
          expect(canonicalJson(reversed)).toBe(text);
        }
      }),
      { numRuns: 300 },
    );
    expect(isCanonicalJsonText('{"b":1,"a":2}')).toBe(false);
    expect(isCanonicalJsonText("{oops")).toBe(false);
  });
});

describe("sha256", SLOW, () => {
  it("matches the FIPS 180-4 test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    expect(sha256Hex("a".repeat(1_000_000))).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    expect(sha256(utf8("abc")).length).toBe(32);
  });

  it("agrees with WebCrypto on random inputs, including every padding boundary", async () => {
    for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 131 + length) % 256);
      expect(sha256Hex(bytes), `length ${length}`).toBe(await webCryptoHex(bytes));
    }
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 600 }), async (bytes) => {
        expect(sha256Hex(bytes)).toBe(await webCryptoHex(bytes));
      }),
      { numRuns: 200 },
    );
    expect(sha256Hex("Acme Robotics, Inc. — é")).toBe(await webCryptoHex(utf8("Acme Robotics, Inc. — é")));
  });
});

describe("ledger hashes and the chain", () => {
  it("derives the genesis hash from the org id", async () => {
    const org = uuid("org:acme");
    expect(genesisHash(org)).toBe(await webCryptoHex(utf8(`cap-table:ledger:v1:${org}`)));
  });

  it("hashes payloads and vesting definitions canonically", () => {
    expect(payloadText({ b: "1", a: "2" })).toBe('{"a":"2","b":"1"}');
    expect(payloadSha256({ b: "1", a: "2" })).toBe(sha256Hex('{"a":"2","b":"1"}'));
    expect(definitionSha256({ type: "EXPLICIT", events: [] })).toBe(sha256Hex('{"events":[],"type":"EXPLICIT"}'));
  });

  function sampleLedger(): LedgerBuilder {
    const b = new LedgerBuilder();
    const cls = b.stockClass("CS", "COMMON");
    const holder = b.stakeholder("S01", "founder");
    b.command("setup", (c) => {
      c.tx("TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT", "2021-02-15", { stock_class_id: cls, new_shares_authorized: "1000" });
      const lot = c.security("CS-1", { family: "STOCK", subtype: "COMMON", stakeholderId: holder, stockClassId: cls, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_STOCK_ISSUANCE", "2021-02-15", {
        security_id: lot,
        custom_id: "CS-1",
        stakeholder_id: holder,
        stock_class_id: cls,
        share_price: { amount: "0.0001", currency: "USD" },
        quantity: "100",
        x_origin: "FOUNDERS_STOCK",
      });
    });
    return b;
  }

  it("chains every column and verifies a whole ledger", () => {
    const b = sampleLedger();
    const result = verifyChain(b.orgId, b.rows);
    expect(result).toEqual({ ok: true, headSeq: 2, headHash: b.rows[1]!.chain_hash });
    const first = b.rows[0]!;
    expect(first.prev_hash).toBe(genesisHash(b.orgId));
    expect(chainInput(first.prev_hash, first).startsWith(first.prev_hash + "{")).toBe(true);
    for (const column of CHAINED_COLUMNS) expect(chainInput(first.prev_hash, first)).toContain(`"${column}":`);
    expect(chainHash(first.prev_hash, first)).toBe(first.chain_hash);
    expect(verifyChain(b.orgId, [])).toEqual({ ok: true, headSeq: 0, headHash: null });
    const incomplete = { ...first } as Partial<TransactionRow>;
    delete incomplete.pulley_ref;
    expect(() => chainHash(first.prev_hash, incomplete as TransactionRow)).toThrow(/missing/);
  });

  it("detects every kind of tampering", () => {
    const b = sampleLedger();
    const [first, second] = b.rows as [TransactionRow, TransactionRow];
    const check = (rows: TransactionRow[]) => {
      const result = verifyChain(b.orgId, rows);
      return result.ok ? "ok" : result.problem;
    };
    expect(check([{ ...first, quantity: "999" }, second])).toBe("CHAIN_HASH_MISMATCH");
    expect(check([{ ...first, payload: first.payload.replace("1000", "2000") }, second])).toBe("PAYLOAD_HASH_MISMATCH");
    expect(check([{ ...first, payload: ` ${first.payload}` }, second])).toBe("PAYLOAD_NOT_CANONICAL");
    expect(check([first, { ...second, prev_hash: first.prev_hash }])).toBe("PREV_HASH_MISMATCH");
    expect(check([second])).toBe("SEQ_GAP");
    expect(check([{ ...first, org_id: uuid("org:other") }])).toBe("ORG_MISMATCH");
    expect(check([first, second])).toBe("ok");
  });

});
