import { api } from '#shared'
import type { Context } from 'hono'
import type { ZodType } from 'zod'
import { ApiError } from '../http.ts'
import type { AppEnv } from '../../types.ts'

const MULTIPART = /^multipart\/form-data(?:\s*;|$)/i

async function readLimitedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('Content-Length') ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError('payload_too_large', 'The uploaded files must total 10 MiB or less')
  }
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new ApiError('payload_too_large', 'The uploaded files must total 10 MiB or less')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function issuesOf(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }))
}

/** Reads one bounded multipart request and validates its parsed fields without retaining the encoded body. */
export async function readImportForm<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<T> {
  const contentType = c.req.header('Content-Type') ?? ''
  if (!MULTIPART.test(contentType)) {
    throw new ApiError('unsupported_media_type', 'Upload the files as a multipart form')
  }
  const bytes = await readLimitedBody(c.req.raw, api.IMPORT_LIMITS.requestBytes)
  let form: FormData
  try {
    form = await new Response(bytes.buffer as ArrayBuffer, { headers: { 'Content-Type': contentType } }).formData()
  } catch {
    throw new ApiError('validation_failed', 'The upload form could not be read')
  }
  const source = form.get('source')
  const asOfDate = form.get('asOfDate')
  const timezone = form.get('timezone')
  const jurisdiction = form.get('jurisdiction')
  const fiscalYearEnd = form.get('fiscalYearEnd')
  const input = {
    ...(typeof source === 'string' ? { source } : {}),
    files: form.getAll('files').filter((value): value is File => value instanceof File),
    ...(typeof asOfDate === 'string' && asOfDate.length > 0 ? { asOfDate } : {}),
    ...(typeof timezone === 'string' ? { timezone } : {}),
    ...(typeof jurisdiction === 'string' ? { jurisdiction } : {}),
    ...(typeof fiscalYearEnd === 'string' ? { fiscalYearEnd } : {}),
  }
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const tooLarge = parsed.error.issues.some((issue) => issue.message.includes('MiB'))
    throw new ApiError(
      tooLarge ? 'payload_too_large' : 'validation_failed',
      tooLarge ? 'Each file must be 5 MiB or smaller, and all files together must fit within 10 MiB'
        : parsed.error.issues[0]?.message ?? 'Some upload fields are invalid',
      issuesOf(parsed.error),
    )
  }
  return parsed.data
}
