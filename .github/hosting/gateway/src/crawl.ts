// What crawlers read at the apex's root (DESIGN.md §1): robots.txt lets every crawler, search engines' and AI
// assistants' alike, read the site but the search results, and names the sitemap, which lists the pages meant to be
// indexed: the landing page, privacy, terms and every docs page. Pages for signed-in people answer with
// X-Robots-Tag: noindex instead of being hidden here, so a crawler can read that they aren't to be indexed.
import { DOCS_PAGES } from './assets/docs-content.ts'
import type { Context } from './context.ts'
import { apexUrl } from './context.ts'
import { assetHeaders } from './http/headers.ts'

const CACHE = 'public, max-age=3600'

export function robotsTxt(ctx: Context): Response {
  const body = [
    '# Insulin Apps: the landing page, privacy, terms and the docs are for every crawler, AI crawlers included.',
    '# The docs are also at /llms.txt, and searchable at /docs/search.json and through the MCP server at /docs/mcp.',
    'User-agent: *',
    'Allow: /',
    'Disallow: /docs/search?',
    '',
    `Sitemap: ${apexUrl(ctx, '/sitemap.xml')}`,
    '',
  ].join('\n')
  return new Response(body, { headers: assetHeaders('text/plain; charset=utf-8', CACHE) })
}

export function sitemapXml(ctx: Context): Response {
  const paths = ['/', '/privacy', '/terms', ...Object.keys(DOCS_PAGES)]
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...paths.map((path) => `  <url><loc>${escapeXml(apexUrl(ctx, path))}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n')
  return new Response(body, { headers: assetHeaders('application/xml; charset=utf-8', CACHE) })
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
