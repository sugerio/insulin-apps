// Vite features the tests use to read repository files without Node typings: `?raw` text imports and eager globs.
declare module "*?raw" {
  const text: string;
  export default text;
}

interface ImportMeta {
  glob<T = unknown>(pattern: string, options: { eager: true; import?: string }): Record<string, T>;
}
