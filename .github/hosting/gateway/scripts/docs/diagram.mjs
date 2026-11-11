// ```diagram blocks: a small line-based language for architecture diagrams, rendered to inline SVG at build time.
// Colours come only from classes (the theme's tokens in src/styles/gateway.css, so light and dark both work); the SVG
// carries geometry attributes and never a style attribute or a colour.
//
//   title: Platform overview                     the figure's caption and the SVG's <title> (required)
//   description: One or two sentences.           the SVG's <desc>, and the diagram's text in llms-full.txt (required)
//   size: 880 x 420                              the drawing's width and height
//   group <id> <x> <y> <w> <h> "Label"           a dashed container with a small label at its top left
//   box <id> <x> <y> <w> <h> [flags] "Title" ["Line" ...]
//                                                a rounded box; flags: accent (the one accent colour), muted, dashed,
//                                                db (a cylinder), pill (fully rounded), left (text aligned left)
//   arrow <from>[.side[:at]] -> <to>[.side[:at]] ["label"] [accent] [dashed] [both] [mid=<x or y>] [label=<0..1>]
//                                                sides l r t b (chosen from the boxes' positions when left out); `at`
//                                                is where on the side, 0 to 1 (0.5); elbows are rounded; `mid` moves
//                                                the middle segment of an elbow; `label` where along the line the
//                                                label sits
//   text <x> <y> [flags] "Text"                  free text; flags: muted, small, bold, start, end, accent
//   # a comment
import { createElement as h } from 'react'

const TITLE_SIZE = 13
const LINE_SIZE = 11.5
const LABEL_SIZE = 11
const RADIUS = 10
const HEAD = 7

// Classes from the stylesheet (Tailwind's fill-* and stroke-* utilities on the theme's colours).
const STYLE = {
  box: 'fill-diagram-box stroke-diagram-stroke',
  accent: 'fill-diagram-accent-soft stroke-diagram-accent',
  muted: 'fill-diagram-muted stroke-diagram-stroke',
  group: 'fill-diagram-group stroke-diagram-stroke',
  title: 'fill-foreground',
  accentTitle: 'fill-diagram-accent-ink',
  line: 'fill-muted-foreground',
  groupLabel: 'fill-muted-foreground',
  edge: 'stroke-diagram-edge',
  edgeAccent: 'stroke-diagram-accent',
  head: 'fill-diagram-edge',
  headAccent: 'fill-diagram-accent',
  labelBack: 'fill-diagram-canvas',
  label: 'fill-muted-foreground',
}

/** Splits a line into words and "quoted strings" (with \" inside them). */
function words(line) {
  const out = []
  const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g
  let match
  while ((match = pattern.exec(line))) out.push(match[1] !== undefined ? { quoted: match[1].replace(/\\(.)/g, '$1') } : { word: match[2] })
  return out
}

function number(value, what) {
  const n = Number(value)
  if (value === undefined || !Number.isFinite(n)) throw new Error(`${what}: expected a number, got ${value ?? 'nothing'}`)
  return n
}

export function parseDiagram(source) {
  const diagram = { title: '', description: '', width: 0, height: 0, groups: [], boxes: new Map(), arrows: [], texts: [] }
  for (const [index, raw] of source.split('\n').entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const where = `line ${index + 1}`
    const meta = /^(title|description|size):\s*(.+)$/.exec(line)
    if (meta) {
      if (meta[1] === 'size') {
        const size = /^(\d+)\s*x\s*(\d+)$/.exec(meta[2])
        if (!size) throw new Error(`${where}: size is "<width> x <height>"`)
        diagram.width = Number(size[1])
        diagram.height = Number(size[2])
      } else {
        diagram[meta[1]] = meta[2].trim()
      }
      continue
    }
    const parts = words(line)
    const kind = parts[0]?.word
    const quoted = parts.filter((part) => part.quoted !== undefined).map((part) => part.quoted)
    const bare = parts.slice(1).filter((part) => part.word !== undefined).map((part) => part.word)
    if (kind === 'box' || kind === 'group') {
      const [id, x, y, w, hgt, ...flags] = bare
      if (!/^[a-z][a-z0-9-]*$/.test(id ?? '')) throw new Error(`${where}: ${kind} needs an id (lower case)`)
      if (diagram.boxes.has(id)) throw new Error(`${where}: the id ${id} is used twice`)
      const shape = { id, kind, x: number(x, where), y: number(y, where), w: number(w, where), h: number(hgt, where), flags: new Set(flags), lines: quoted }
      for (const flag of flags) {
        if (!['accent', 'muted', 'dashed', 'db', 'pill', 'left'].includes(flag)) throw new Error(`${where}: unknown flag ${flag}`)
      }
      if (!quoted.length) throw new Error(`${where}: ${kind} ${id} needs a "label"`)
      diagram.boxes.set(id, shape)
      if (kind === 'group') diagram.groups.push(shape)
    } else if (kind === 'arrow') {
      const arrowAt = bare.indexOf('->')
      if (arrowAt !== 1) throw new Error(`${where}: arrow is "arrow <from> -> <to>"`)
      const options = { from: bare[0], to: bare[2], label: quoted[0] ?? '', flags: new Set(), mid: null, labelAt: 0.5 }
      for (const word of bare.slice(3)) {
        if (word.startsWith('mid=')) options.mid = number(word.slice(4), where)
        else if (word.startsWith('label=')) options.labelAt = number(word.slice(6), where)
        else if (['accent', 'dashed', 'both'].includes(word)) options.flags.add(word)
        else throw new Error(`${where}: unknown arrow option ${word}`)
      }
      diagram.arrows.push({ ...options, where })
    } else if (kind === 'text') {
      const [x, y, ...flags] = bare
      for (const flag of flags) {
        if (!['muted', 'small', 'bold', 'start', 'end', 'accent'].includes(flag)) throw new Error(`${where}: unknown text flag ${flag}`)
      }
      if (!quoted.length) throw new Error(`${where}: text needs a "string"`)
      diagram.texts.push({ x: number(x, where), y: number(y, where), flags: new Set(flags), text: quoted[0] })
    } else {
      throw new Error(`${where}: unknown statement "${kind}"`)
    }
  }
  if (!diagram.title) throw new Error('a diagram needs a title:')
  if (!diagram.description) throw new Error('a diagram needs a description:')
  if (!diagram.width || !diagram.height) throw new Error('a diagram needs a size:')
  return diagram
}

/** An end of an arrow: `box`, `box.r` or `box.r:0.3`. */
function endpoint(spec, diagram, where) {
  const match = /^([a-z][a-z0-9-]*)(?:\.([lrtb])(?::([0-9.]+))?)?$/.exec(spec ?? '')
  if (!match) throw new Error(`${where}: arrow end "${spec}"`)
  const box = diagram.boxes.get(match[1])
  if (!box) throw new Error(`${where}: no box ${match[1]}`)
  return { box, side: match[2] ?? null, at: match[3] === undefined ? 0.5 : number(match[3], where) }
}

function anchor({ box, side, at }) {
  switch (side) {
    case 'l': return { x: box.x, y: box.y + box.h * at }
    case 'r': return { x: box.x + box.w, y: box.y + box.h * at }
    case 't': return { x: box.x + box.w * at, y: box.y }
    default: return { x: box.x + box.w * at, y: box.y + box.h }
  }
}

/** The sides an arrow leaves and enters by, when not given: the boxes' relative position decides. */
function chooseSides(from, to) {
  const a = { x: from.box.x + from.box.w / 2, y: from.box.y + from.box.h / 2 }
  const b = { x: to.box.x + to.box.w / 2, y: to.box.y + to.box.h / 2 }
  const horizontal = Math.abs(b.x - a.x) - (from.box.w + to.box.w) / 2 > Math.abs(b.y - a.y) - (from.box.h + to.box.h) / 2
  if (!from.side) from.side = horizontal ? (b.x > a.x ? 'r' : 'l') : (b.y > a.y ? 'b' : 't')
  if (!to.side) to.side = horizontal ? (b.x > a.x ? 'l' : 'r') : (b.y > a.y ? 't' : 'b')
}

const isHorizontal = (side) => side === 'l' || side === 'r'
const round = (n) => Math.round(n * 10) / 10

/** The arrow's corner points: straight, or orthogonal with one or two bends. */
function route(p, q, fromSide, toSide, mid) {
  if (isHorizontal(fromSide) && isHorizontal(toSide)) {
    if (Math.abs(p.y - q.y) < 0.5) return [p, { x: q.x, y: p.y }]
    const mx = mid ?? (p.x + q.x) / 2
    return [p, { x: mx, y: p.y }, { x: mx, y: q.y }, q]
  }
  if (!isHorizontal(fromSide) && !isHorizontal(toSide)) {
    if (Math.abs(p.x - q.x) < 0.5) return [p, { x: p.x, y: q.y }]
    const my = mid ?? (p.y + q.y) / 2
    return [p, { x: p.x, y: my }, { x: q.x, y: my }, q]
  }
  if (isHorizontal(fromSide)) return [p, { x: q.x, y: p.y }, q]
  return [p, { x: p.x, y: q.y }, q]
}

/** Moves `point` `by` units toward `toward`. */
function toward(point, target, by) {
  const dx = target.x - point.x
  const dy = target.y - point.y
  const length = Math.hypot(dx, dy) || 1
  return { x: point.x + (dx / length) * by, y: point.y + (dy / length) * by }
}

/** An SVG path through the points, with rounded corners. */
function pathData(points) {
  let d = `M${round(points[0].x)} ${round(points[0].y)}`
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1]
    const corner = points[i]
    const following = points[i + 1]
    const r = Math.min(8, Math.hypot(corner.x - prev.x, corner.y - prev.y) / 2, Math.hypot(following.x - corner.x, following.y - corner.y) / 2)
    const a = toward(corner, prev, r)
    const b = toward(corner, following, r)
    d += ` L${round(a.x)} ${round(a.y)} Q${round(corner.x)} ${round(corner.y)} ${round(b.x)} ${round(b.y)}`
  }
  const last = points[points.length - 1]
  return `${d} L${round(last.x)} ${round(last.y)}`
}

/** A filled triangle whose tip is at `tip`, pointing away from `from`. */
function arrowHead(tip, from, className, key) {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x)
  const back = { x: tip.x - Math.cos(angle) * HEAD, y: tip.y - Math.sin(angle) * HEAD }
  const spread = HEAD * 0.45
  const left = { x: back.x + Math.sin(angle) * spread, y: back.y - Math.cos(angle) * spread }
  const right = { x: back.x - Math.sin(angle) * spread, y: back.y + Math.cos(angle) * spread }
  return h('path', { key, d: `M${round(tip.x)} ${round(tip.y)} L${round(left.x)} ${round(left.y)} L${round(right.x)} ${round(right.y)} Z`, className })
}

/** The point `fraction` of the way along the polyline. */
function along(points, fraction) {
  const lengths = points.slice(1).map((point, i) => Math.hypot(point.x - points[i].x, point.y - points[i].y))
  let left = lengths.reduce((sum, n) => sum + n, 0) * fraction
  for (let i = 0; i < lengths.length; i += 1) {
    if (left <= lengths[i] || i === lengths.length - 1) return toward(points[i], points[i + 1], Math.min(left, lengths[i]))
    left -= lengths[i]
  }
  return points[0]
}

/** About how wide a label is: the docs use the system sans-serif, where an average character is ~0.56 em. */
const textWidth = (text, size) => text.length * size * 0.56

function renderShape(shape) {
  const { x, y, w, h: height, flags, lines } = shape
  const dash = flags.has('dashed') || shape.kind === 'group' ? { strokeDasharray: '4 3' } : {}
  if (shape.kind === 'group') {
    return h('g', { key: shape.id },
      h('rect', { x, y, width: w, height, rx: 14, className: STYLE.group, strokeWidth: 1, ...dash }),
      h('text', { x: x + 14, y: y + 20, fontSize: LABEL_SIZE, fontWeight: 600, letterSpacing: '0.06em', className: STYLE.groupLabel }, lines[0].toUpperCase()))
  }
  const fill = flags.has('accent') ? STYLE.accent : flags.has('muted') ? STYLE.muted : STYLE.box
  const outline = flags.has('db')
    ? h('path', {
      d: `M${x} ${y + 7} a${w / 2} 7 0 0 1 ${w} 0 v${height - 14} a${w / 2} 7 0 0 1 ${-w} 0 Z M${x} ${y + 7} a${w / 2} 7 0 0 0 ${w} 0`,
      className: fill, strokeWidth: 1.25, ...dash,
    })
    : h('rect', { x, y, width: w, height, rx: flags.has('pill') ? height / 2 : RADIUS, className: fill, strokeWidth: flags.has('accent') ? 1.5 : 1.25, ...dash })
  const [title, ...rest] = lines
  const block = TITLE_SIZE + rest.length * (LINE_SIZE + 4)
  const top = y + height / 2 - block / 2 + (flags.has('db') ? 4 : 0)
  const left = flags.has('left')
  const tx = left ? x + 14 : x + w / 2
  const anchorProps = { textAnchor: left ? 'start' : 'middle', dominantBaseline: 'central' }
  return h('g', { key: shape.id },
    outline,
    h('text', { x: tx, y: round(top + TITLE_SIZE / 2), fontSize: TITLE_SIZE, fontWeight: 600, className: flags.has('accent') ? STYLE.accentTitle : STYLE.title, ...anchorProps }, title),
    rest.map((line, i) => h('text', { key: i, x: tx, y: round(top + TITLE_SIZE + 4 + i * (LINE_SIZE + 4) + LINE_SIZE / 2), fontSize: LINE_SIZE, className: STYLE.line, ...anchorProps }, line)))
}

function renderArrow(arrow, diagram, key) {
  const from = endpoint(arrow.from, diagram, arrow.where)
  const to = endpoint(arrow.to, diagram, arrow.where)
  chooseSides(from, to)
  const p = anchor(from)
  const q = anchor(to)
  const points = route(p, q, from.side, to.side, arrow.mid)
  const accent = arrow.flags.has('accent')
  // The line stops at the arrowhead's base, so its end doesn't show past the tip.
  const drawn = points.map((point) => ({ ...point }))
  const end = drawn.length - 1
  drawn[end] = toward(points[end], points[end - 1], HEAD - 1)
  if (arrow.flags.has('both')) drawn[0] = toward(points[0], points[1], HEAD - 1)
  const parts = [
    h('path', { key: 'line', d: pathData(drawn), fill: 'none', className: accent ? STYLE.edgeAccent : STYLE.edge, strokeWidth: accent ? 1.5 : 1.25, strokeLinecap: 'round', strokeLinejoin: 'round', ...(arrow.flags.has('dashed') ? { strokeDasharray: '4 3' } : {}) }),
    arrowHead(points[end], points[end - 1], accent ? STYLE.headAccent : STYLE.head, 'head'),
  ]
  if (arrow.flags.has('both')) parts.push(arrowHead(points[0], points[1], accent ? STYLE.headAccent : STYLE.head, 'tail'))
  if (arrow.label) {
    const at = along(points, arrow.labelAt)
    const width = textWidth(arrow.label, LABEL_SIZE) + 12
    parts.push(
      h('rect', { key: 'label-back', x: round(at.x - width / 2), y: round(at.y - 9), width: round(width), height: 18, rx: 9, className: STYLE.labelBack }),
      h('text', { key: 'label', x: round(at.x), y: round(at.y), fontSize: LABEL_SIZE, textAnchor: 'middle', dominantBaseline: 'central', className: STYLE.label }, arrow.label),
    )
  }
  return h('g', { key }, parts)
}

function renderText(text, key) {
  const { flags } = text
  const className = flags.has('accent') ? STYLE.accentTitle : flags.has('muted') ? STYLE.line : STYLE.title
  return h('text', {
    key, x: text.x, y: text.y, fontSize: flags.has('small') ? LABEL_SIZE : TITLE_SIZE, fontWeight: flags.has('bold') ? 600 : 400,
    textAnchor: flags.has('start') ? 'start' : flags.has('end') ? 'end' : 'middle', dominantBaseline: 'central', className,
  }, text.text)
}

/**
 * The diagram as a <figure>: the SVG (role img, with <title> and <desc>) in a scrollable frame, and its title as the
 * caption. `id` makes the title and description ids unique on the page.
 */
export function renderDiagram(source, id) {
  const diagram = parseDiagram(source)
  const titleId = `${id}-title`
  const descId = `${id}-desc`
  // Groups first (behind), then boxes, then arrows and their labels on top, then free text.
  const boxes = [...diagram.boxes.values()].filter((shape) => shape.kind === 'box')
  return h('figure', { className: 'mt-8 first:mt-0' },
    h('div', { className: 'overflow-x-auto rounded-xl border bg-diagram-canvas p-3 sm:p-5' },
      h('svg', {
        viewBox: `0 0 ${diagram.width} ${diagram.height}`, width: diagram.width, height: diagram.height, role: 'img', 'aria-labelledby': `${titleId} ${descId}`,
        className: 'mx-auto block h-auto w-full min-w-[40rem] max-w-full font-sans', xmlns: 'http://www.w3.org/2000/svg',
      },
      h('title', { id: titleId }, diagram.title),
      h('desc', { id: descId }, diagram.description),
      diagram.groups.map(renderShape),
      boxes.map(renderShape),
      diagram.arrows.map((arrow, i) => renderArrow(arrow, diagram, `a${i}`)),
      diagram.texts.map((text, i) => renderText(text, `t${i}`)))),
    h('figcaption', { className: 'mt-2 text-center text-sm text-muted-foreground' }, diagram.title))
}
