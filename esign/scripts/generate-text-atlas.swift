import Foundation
import CoreGraphics
import CoreText
let path=CommandLine.arguments[1]
guard let provider=CGDataProvider(filename:path), let font=CGFont(provider) else { fatalError("font") }
let width=24, height=32
var output=[UInt8]()
for c in 32...126 {
 var data=[UInt8](repeating:0,count:width*height*4)
 data.withUnsafeMutableBytes { ptr in
  let ctx=CGContext(data:ptr.baseAddress,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.setShouldAntialias(false);ctx.setAllowsAntialiasing(false)
  ctx.setFillColor(CGColor(gray:1,alpha:1));ctx.setFont(font);ctx.setFontSize(23)
  var chars=[UniChar(c)];var glyphs=[CGGlyph](repeating:0,count:1)
  let ct=CTFontCreateWithGraphicsFont(font,23,nil,nil)
  precondition(CTFontGetGlyphsForCharacters(ct,&chars,&glyphs,1))
  var pos=[CGPoint(x:1,y:6)];CTFontDrawGlyphs(ct,&glyphs,&pos,1,ctx)
 }
 for y in 0..<height { for x in 0..<width { output.append(data[(y*width+x)*4+3] > 0 ? 1:0) } }
}
var packed=[UInt8]()
for i in stride(from:0,to:output.count,by:8) {
 var value:UInt8=0
 for j in 0..<8 { value |= output[i+j] << (7-j) }
 packed.append(value)
}
FileHandle.standardOutput.write(Data(packed).base64EncodedData())
