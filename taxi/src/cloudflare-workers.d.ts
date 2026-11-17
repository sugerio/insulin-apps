// Type for the Workers runtime module used only by the Worker build.
declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>
}
