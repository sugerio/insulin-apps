import { describe, expect, it } from "vitest";
import { createOrgRequestSchema, DEFAULT_ORG_SETTINGS, orgSchema, orgSettingsSchema, patchOrgRequestSchema, storedOrgSettingsSchema } from "../../../src/app/shared/api/orgs.ts";
import { DOCUMENT_ID, OTHER_DOCUMENT_ID, org, settings } from "./fixtures.ts";

// The portal settings' privacy notice is a company resource the
// portal footer opens, designated like the notice of exercise form. Writes require the key (only null clears it); rows
// stored before the key existed still decode, through the read side.

describe("settings.portal.privacyNoticeDocumentId", () => {
  const { privacyNoticeDocumentId: _dropped, ...storedBefore } = settings.portal;

  it("is kept when stored", () => {
    expect(storedOrgSettingsSchema.parse(settings).portal.privacyNoticeDocumentId).toBe(OTHER_DOCUMENT_ID);
    expect(orgSchema.parse(org).settings.portal.privacyNoticeDocumentId).toBe(OTHER_DOCUMENT_ID);
  });

  it("reads as null (no notice designated) for a row stored before the key existed", () => {
    const parsed = storedOrgSettingsSchema.parse({ ...settings, portal: storedBefore });
    expect(parsed.portal).toEqual({ howToExerciseText: settings.portal.howToExerciseText, noticeFormDocumentId: DOCUMENT_ID, privacyNoticeDocumentId: null });
    // An org answer decodes the stored row the same way.
    expect(orgSchema.parse({ ...org, settings: { ...settings, portal: storedBefore } }).settings.portal.privacyNoticeDocumentId).toBeNull();
    expect(DEFAULT_ORG_SETTINGS.portal.privacyNoticeDocumentId).toBeNull();
    expect(orgSettingsSchema.parse(DEFAULT_ORG_SETTINGS)).toEqual(DEFAULT_ORG_SETTINGS);
  });

  it("is required on writes, like its siblings, so leaving it out never clears a published notice", () => {
    expect(orgSettingsSchema.safeParse({ ...settings, portal: storedBefore }).success).toBe(false);
    expect(patchOrgRequestSchema.safeParse({ version: 3, settings: { portal: storedBefore } }).success).toBe(false);
    expect(createOrgRequestSchema.safeParse({ orgKey: "acme-demo", legalName: "Acme Robotics, Inc.", displayName: "Acme Robotics", timezone: "America/Los_Angeles", settings: { portal: storedBefore } }).success).toBe(false);
  });

  it("is set by a PATCH of the whole portal section, and cleared only by an explicit null", () => {
    const set = patchOrgRequestSchema.parse({ version: 3, settings: { portal: { ...storedBefore, privacyNoticeDocumentId: OTHER_DOCUMENT_ID } } });
    expect(set.settings?.portal?.privacyNoticeDocumentId).toBe(OTHER_DOCUMENT_ID);
    const cleared = patchOrgRequestSchema.parse({ version: 3, settings: { portal: { ...storedBefore, privacyNoticeDocumentId: null } } });
    expect(cleared.settings?.portal?.privacyNoticeDocumentId).toBeNull();
    // A PATCH of another section leaves the portal section alone.
    expect(patchOrgRequestSchema.parse({ version: 3, settings: { display: { shareDecimals: 2, priceDecimals: 4 } } }).settings?.portal).toBeUndefined();
  });

  it("stays strict on both sides: an unknown portal key or a malformed id is refused", () => {
    for (const schema of [orgSettingsSchema, storedOrgSettingsSchema]) {
      expect(schema.safeParse({ ...settings, portal: { ...settings.portal, privacyNoticeText: "Our notice" } }).success).toBe(false);
      expect(schema.safeParse({ ...settings, portal: { ...settings.portal, privacyNoticeDocumentId: "privacy.pdf" } }).success).toBe(false);
      expect(schema.safeParse({ ...settings, portal: { ...settings.portal, privacyNoticeDocumentId: null } }).success).toBe(true);
    }
  });
});
