import './setup.ts'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SourceList } from '../../src/app/components/Answer.tsx'
import { isDeck, pagesLabel, pagesOfRange } from '../../src/app/lib/format.ts'
import type { AskSource } from '../../src/app/lib/types.ts'

// A cited passage names the pages (or slides) it runs over: "page 4", "pages 1–4"; in a PowerPoint deck "slide 3",
// "slides 3–4". An engine that sends no pageEnd is read as one page.

const source = (n: number, documentName: string, page: number | null, pageEnd?: number | null): AskSource => ({
  n, collectionId: 'c1', passageId: `p${n}`, documentId: `d${n}`, documentName, kind: 'file', page, ...(pageEnd === undefined ? {} : { pageEnd }),
  start: 0, end: 10, text: 'The rollout only advances at 99.6 percent.', textHash: 'h', score: 0.8, outdated: false,
})

describe('the pages a citation names', () => {
  it('words a page, a range of pages, a slide and a range of slides', () => {
    expect(pagesLabel(4, 4)).toBe('page 4')
    expect(pagesLabel(1, 4)).toBe('pages 1–4')
    expect(pagesLabel(3, undefined)).toBe('page 3')
    expect(pagesLabel(3, 4, true)).toBe('slides 3–4')
    expect(pagesLabel(2, 2, true)).toBe('slide 2')
    expect(pagesLabel(null, null)).toBe('')
    expect(isDeck({ name: 'Launch.pptx' })).toBe(true)
    expect(isDeck({ name: 'launch.PPTX' })).toBe(true)
    expect(isDeck({ name: 'Launch.pdf', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })).toBe(true)
    expect(isDeck({ name: 'Launch.pdf', type: 'application/pdf' })).toBe(false)
  })

  it('finds the pages highlighted words run over in a page map', () => {
    const pages = [{ page: 1, start: 0, end: 10 }, { page: 2, start: 12, end: 20 }, { page: 3, start: 22, end: 30 }]
    expect(pagesOfRange(pages, 2, 25)).toEqual([1, 3])
    expect(pagesOfRange(pages, 12, 20)).toEqual([2, 2])
    expect(pagesOfRange(pages, 0, 10)).toEqual([1, 1]) // ending at the page's end stays on it
    expect(pagesOfRange([], 0, 10)).toBeNull()
  })

  it('the sources list each citation\'s pages or slides', () => {
    render(<SourceList sources={[source(1, 'Release.pdf', 1, 4), source(2, 'Launch.pptx', 3, 4), source(3, 'Old.pdf', 2), source(4, 'Notes.md', null, null)]} onOpen={() => undefined} />)
    expect(screen.getByText(/· pages 1–4/)).toBeTruthy()
    expect(screen.getByText(/· slides 3–4/)).toBeTruthy()
    expect(screen.getByText(/· page 2/)).toBeTruthy()
    expect(screen.queryAllByText(/page|slide/).length).toBe(3)
  })
})
