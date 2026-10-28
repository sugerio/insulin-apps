export interface AppConfig {
  origin: string
  portalEnabled: true
}

export function requestConfig(request: Request): AppConfig {
  return { origin: new URL(request.url).origin, portalEnabled: true }
}
