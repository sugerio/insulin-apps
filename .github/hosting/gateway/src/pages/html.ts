// The one place HTML is escaped. Every page, e-mail and fragment is built with the `html` tag: interpolated values are
// escaped unless they are themselves `Html` built by this module, so markup can only come from template literals in
// the source code.

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export class Html {
  readonly value: string

  constructor(value: string) {
    this.value = value
  }

  toString(): string {
    return this.value
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character]!)
}

function render(value: unknown): string {
  if (value instanceof Html) return value.value
  if (Array.isArray(value)) return value.map(render).join('')
  if (value === null || value === undefined || value === false) return ''
  return escapeHtml(String(value))
}

/** Template tag: escapes every interpolation except `Html` values (and arrays of them). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? ''
  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? '')
  })
  return new Html(out)
}

export const EMPTY = new Html('')
