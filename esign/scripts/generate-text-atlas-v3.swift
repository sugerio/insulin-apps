// Generates the anti-aliased Liberation Sans atlas for Title and Date signed fields
// (fonts/text-atlas-v3.ts, renderer liberation-sans-aa-v3 in field-render.ts):
//   swift scripts/generate-text-atlas-v3.swift node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf
// Output, base64: 95 bytes of advance widths in pixels (one per printable ASCII character, 32–126),
// then each character's 72 × 96 cell as 4-bit coverage (0–15), two pixels a byte, high nibble first,
// rows top to bottom. Each glyph is drawn 69 pixels high with its origin at x = 3, baseline 18 rows
// above the bottom: three times the v2 atlas (generate-text-atlas.swift), so the text keeps its size.
import Foundation
import CoreGraphics
import CoreText

let path = CommandLine.arguments[1]
guard let provider = CGDataProvider(filename: path), let font = CGFont(provider) else { fatalError("font") }
let width = 72, height = 96, size: CGFloat = 69
let ct = CTFontCreateWithGraphicsFont(font, size, nil, nil)
var advances = [UInt8]()
var coverage = [UInt8]()
for c in 32...126 {
  var chars = [UniChar(c)]
  var glyphs = [CGGlyph](repeating: 0, count: 1)
  precondition(CTFontGetGlyphsForCharacters(ct, &chars, &glyphs, 1))
  var advance = CGSize.zero
  CTFontGetAdvancesForGlyphs(ct, .horizontal, &glyphs, &advance, 1)
  let rounded = Int(advance.width.rounded())
  precondition(rounded > 0 && rounded < 256)
  advances.append(UInt8(rounded))
  var data = [UInt8](repeating: 0, count: width * height * 4)
  data.withUnsafeMutableBytes { ptr in
    let ctx = CGContext(data: ptr.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setShouldAntialias(true); ctx.setAllowsAntialiasing(true)
    ctx.setShouldSmoothFonts(false); ctx.setAllowsFontSmoothing(false)
    ctx.setShouldSubpixelPositionFonts(false); ctx.setShouldSubpixelQuantizeFonts(false)
    ctx.setFillColor(CGColor(gray: 1, alpha: 1))
    var pos = [CGPoint(x: 3, y: 18)]
    CTFontDrawGlyphs(ct, &glyphs, &pos, 1, ctx)
  }
  for y in 0..<height {
    for x in 0..<width {
      // Nothing may touch the cell's edge: a glyph that does would be cut off.
      let alpha = Int(data[(y * width + x) * 4 + 3])
      if alpha > 0 { precondition(x > 0 && x < width - 1 && y > 0 && y < height - 1, "glyph \(c) touches its cell's edge") }
      coverage.append(UInt8((alpha * 15 + 127) / 255))
    }
  }
}
var packed = advances
for i in stride(from: 0, to: coverage.count, by: 2) { packed.append(coverage[i] << 4 | coverage[i + 1]) }
FileHandle.standardOutput.write(Data(packed).base64EncodedData())
