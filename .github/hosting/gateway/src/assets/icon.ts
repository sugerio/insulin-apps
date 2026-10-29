// The Insulin Apps mark: the "l" of the Insulin wordmark, one orange slanted bar, centred on a near-black rounded tile.
// The bar is the wordmark's own path (drawn in a 1000-unit space, 229.04 tall). The tile is 327.2 units square, so the
// bar is exactly 70% of its height, and the path is only moved, not scaled: its bounding-box centre (581.43, 114.52)
// lands on the tile's centre (163.6, 163.6). The tile's corner radius is 22% of its size.
//
// It is the favicon of every gateway page (/__insulin/icon.svg here; /favicon.ico and /apple-touch-icon.png are PNG
// renderings in icons.ts, made by `npm run build:icons`) and the logo in the top bar (components/brand.tsx).

export const MARK_PATH = 'M598.67 0 L632.04 0 L564.19 229.04 L530.82 229.04 Z'
export const MARK_ORANGE = '#FF6B35'
export const MARK_TILE = '#0A0A0A'
export const MARK_SIZE = 327.2
export const MARK_RADIUS = 71.98
export const MARK_OFFSET = 'translate(-417.83 49.08)'

/** The mark as a standalone SVG document; `radius: 0` gives a full-bleed square (Apple rounds its own icons). */
export function markSvg({ radius = MARK_RADIUS }: { radius?: number } = {}): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_SIZE} ${MARK_SIZE}">`
    + `<rect width="${MARK_SIZE}" height="${MARK_SIZE}" rx="${radius}" fill="${MARK_TILE}"/>`
    + `<path fill="${MARK_ORANGE}" transform="${MARK_OFFSET}" d="${MARK_PATH}"/>`
    + '</svg>\n'
}

/** /__insulin/icon.svg */
export const ICON_SVG = markSvg()
