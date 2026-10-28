import { api, engine } from '#shared'
import {
  buildImportPreview,
  buildTemplateImportPreview,
  type ImportPreview as CoreImportPreview,
  type ImportSourceSystem,
  type ImportWritePlan,
  type SourceLocation,
  type UploadedImportFile,
} from '../../../import/index.ts'
import { previewOrgId, retryOrgId, uuidForImport } from './ids.ts'
import { addImportProblems, validateImportPlan } from './validate.ts'

export interface ImportFileDigest {
  name: string
  sha256: string
}

export { previewOrgId, retryOrgId, uuidForImport }

export async function uploadedFiles(files: readonly File[]): Promise<UploadedImportFile[]> {
  return Promise.all(files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })))
}

export function fileDigests(files: readonly UploadedImportFile[]): ImportFileDigest[] {
  return files
    .map((file) => ({ name: file.name, sha256: engine.sha256Hex(file.bytes) }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.sha256.localeCompare(right.sha256))
}

export function buildCorePreview(
  source: ImportSourceSystem,
  files: readonly UploadedImportFile[],
  options: { asOfDate?: string; today?: string; orgId: string; fallbackCurrency?: string },
): CoreImportPreview {
  const preview = source === 'template'
    ? buildTemplateImportPreview(files[0]!, options)
    : buildImportPreview(files, options)
  return preview.plan ? addImportProblems(preview, validateImportPlan(preview, preview.plan)) : preview
}

export function planSha256(plan: ImportWritePlan | null): string {
  return engine.sha256Hex(engine.canonicalJson(plan))
}

export function importCounts(preview: CoreImportPreview): api.ImportCounts {
  const plan = preview.plan
  return api.importCountsSchema.parse({
    stakeholders: plan?.referenceRows.filter((row) => row.entity === 'stakeholder').length ?? preview.draft.stakeholders.length,
    shareClasses: plan?.referenceRows.filter((row) => row.entity === 'stock_class').length ?? preview.draft.shareClasses.length,
    equityPlans: plan?.referenceRows.filter((row) => row.entity === 'stock_plan').length ?? preview.draft.equityPlans.length,
    securities: plan?.commands.reduce((sum, command) => sum + command.securities.length, 0) ?? preview.draft.securities.length,
    commands: plan?.commands.length ?? 0,
    transactions: plan?.commands.reduce((sum, command) => sum + command.transactions.length, 0) ?? 0,
  })
}

function location(source: SourceLocation | null): { file: string | null; sheet: string | null; row: number | null; column: string | null } {
  return {
    file: source?.file ?? null,
    sheet: source?.sheet ?? null,
    row: source?.row ?? null,
    column: source?.column ?? null,
  }
}

function uploadedTotals(totals: CoreImportPreview['totals']['uploaded']): api.ImportTotals['uploaded'] {
  if (!totals) return null
  return {
    company: totals.company ? {
      fullyDiluted: totals.company.fullyDiluted,
      issued: totals.company.issued,
      outstanding: totals.company.outstanding,
    } : null,
    classes: totals.classes.map(({ source: _source, ...row }) => row),
    plans: totals.plans.map(({ source: _source, ...row }) => row),
    holders: totals.holders.map(({ source: _source, ...row }) => row),
    securities: totals.securities.map(({ source: _source, ...row }) => row),
    detailed: totals.detailed ? {
      company: totals.detailed.company ? {
        fullyDiluted: totals.detailed.company.fullyDiluted,
        issuedAndOutstanding: totals.detailed.company.issuedAndOutstanding,
      } : null,
      holders: totals.detailed.holders.map(({ source: _source, ...row }) => row),
    } : null,
  }
}

export function publicPreview(preview: CoreImportPreview): api.ImportPreview {
  return api.importPreviewSchema.parse({
    detectedFiles: preview.detectedFiles,
    currency: preview.plan
      ? profileCurrency(preview.plan)
      : preview.draft.currency,
    problems: preview.problems.map((problem) => ({
      severity: problem.severity,
      message: problem.message,
      ...location(problem.source),
    })),
    openingBalances: preview.openingBalances.map((balance) => ({
      displayId: balance.displayId,
      date: balance.date,
      reason: balance.reason,
      ...location(balance.source),
    })),
    assumptions: preview.draft.assumptions,
    totals: {
      uploaded: uploadedTotals(preview.totals.uploaded),
      app: preview.totals.app,
      reconciliation: preview.totals.reconciliation.map(({ source, ...line }) => ({ ...line, ...location(source) })),
    },
    canImport: preview.canImport,
    suggestedAsOfDate: preview.draft.suggestedAsOfDate,
    counts: importCounts(preview),
  })
}

function profileCurrency(plan: ImportWritePlan): string {
  const profile = plan.referenceRows.find((row) => row.entity === 'org_profile')
  if (!profile) throw new Error('The reviewed import has no company profile')
  return profile.currency
}
