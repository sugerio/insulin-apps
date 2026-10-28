import { engine } from '#shared'

export function uuidForImport(label: string): string {
  const hex = engine.sha256Hex(`server-import:${label}`)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export const previewOrgId = (runId: string) => uuidForImport(`preview-org:${runId}`)
export const retryOrgId = (runId: string, priorOrgId: string) => uuidForImport(`retry-org:${runId}:${priorOrgId}`)
