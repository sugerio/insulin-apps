---
title: Searching the docs
description: Search these docs on the page or as JSON, connect an AI agent to the docs' own MCP server with no sign-in, and what search engines and AI crawlers may read.
order: 8
---

These docs are public: anyone can read and search them, and so can search engines, AI assistants and agents, with no
account. This page covers the search box, the search as JSON, the docs' own MCP server for AI agents, and what crawlers
may read.

The docs describe Insulin Apps in general. Nothing here reaches your organization or its data: for that, an agent
connects to an app's own MCP server and signs in ([AI agents over MCP](/docs/platform/ai-agents)).

## The search box

Every docs page has a search box: at the top of the navigation on a wide screen, and above the **Documentation menu** on
a narrow one. Type a few words and press Enter. [The search page](/docs/search) lists up to 20 pages, best first, each
with its section, the heading where the words are, and a passage with the words marked; the link opens the page at that
heading.

- Words match in any case, and a word also finds its other forms: **rotate** finds "rotating" and "rotation".
- A page that has every word comes before one that has only some. Common words such as "how" or "the" are ignored when
  there are others.
- Search pages aren't indexed by search engines; the pages they find are.

## Search as JSON

Programs search the same way with a `GET` to `https://insulinapps.com/docs/search.json`. It needs no sign-in and answers
any origin (CORS), so a page on another site can call it too.

```bash
curl 'https://insulinapps.com/docs/search.json?q=rotate+secret&limit=3'
```

| Parameter | Meaning |
|---|---|
| `q` | The words to search for, up to 200 characters. Required. |
| `limit` | How many results, 1 to 25; 10 if left out. |

The answer is JSON, the best result first:

```json
{
  "query": "rotate secret",
  "results": [
    {
      "title": "API access with OAuth clients",
      "section": "Platform",
      "heading": "Rotate the secret without downtime",
      "url": "https://insulinapps.com/docs/platform/api-and-service-accounts#rotate-the-secret-without-downtime",
      "markdown": "https://insulinapps.com/docs/platform/api-and-service-accounts.md",
      "snippet": "Rotate secret makes a new secret and shows it once. The previous secret keeps working for 24 hours…"
    }
  ]
}
```

`heading` is null when the words are at the top of the page, before its first heading. `markdown` is the whole page as
Markdown. Without `q`, the answer is `400` with `"error": "missing_query"`.

## The docs' MCP server

AI agents can search and read the docs through their own MCP server, `https://insulinapps.com/docs/mcp`, which needs
no sign-in and no OAuth. It is separate from the apps' MCP servers: it only reads these public pages.

| Tool | What it does |
|---|---|
| `search_docs` | Searches the docs: `query`, the words, and `limit`, 1 to 20 results (8 if left out). Each result has the page's title, section, heading, address and a passage. |
| `read_doc` | Reads one page as Markdown: `page` is its address, such as `/docs/platform/ai-agents` or the full `https://insulinapps.com/docs/platform/ai-agents` (a `#heading` or `.md` at the end is fine). |
| `list_docs` | Lists every page, by section, with its address and description. |

An agent usually searches first, then reads the best page. The commands below name the server `insulin-apps-docs`; any
name works.

### Claude Code

```bash
claude mcp add --transport http insulin-apps-docs https://insulinapps.com/docs/mcp
```

Add `--scope user` to have it in every project. There is nothing to sign in to.

### Codex CLI

```bash
codex mcp add insulin-apps-docs --url https://insulinapps.com/docs/mcp
```

### Gemini CLI

```bash
gemini mcp add --transport http insulin-apps-docs https://insulinapps.com/docs/mcp
```

### opencode

```bash
opencode mcp add insulin-apps-docs --url https://insulinapps.com/docs/mcp
```

### Claude.ai, ChatGPT and other clients

Add a custom connector with the address `https://insulinapps.com/docs/mcp` and no authentication. Any other MCP client
connects the same way: Streamable HTTP, no sign-in.

### For MCP client developers

- **Transport**: stateless Streamable HTTP. `POST` JSON-RPC to `/docs/mcp` and get JSON back (no server-sent events, no
  session); a `GET` answers `405`. Protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05`.
- **No authorization**: there is no `WWW-Authenticate` challenge and no OAuth metadata for this server.
- **Results**: each tool answers with readable text for the model and, for `search_docs` and `list_docs`, the same as
  `structuredContent`.
- **Limits**: a JSON-RPC batch holds at most 10 messages. Requests are limited per IP address; past the limit the
  server answers `429` with `Retry-After`.

## For search engines and AI crawlers

- `https://insulinapps.com/robots.txt` lets every crawler, AI crawlers included, read the site; only the search pages'
  results are left out.
- `https://insulinapps.com/sitemap.xml` lists the landing page, the privacy notice, the terms and every docs page.
- `https://insulinapps.com/llms.txt` (the same as [`/docs/llms.txt`](/docs/llms.txt)) lists every page with its
  description, and `https://insulinapps.com/llms-full.txt` has all of them in one file. Each page's Markdown is at its
  address with `.md` added.
- Each page has a description, a canonical address, Open Graph tags for link previews, and schema.org data
  (`TechArticle` and `BreadcrumbList`) as microdata.

Pages for signed-in people (settings, accounts, the apps) are never indexed, and the apps' own hosts aren't part of this.
