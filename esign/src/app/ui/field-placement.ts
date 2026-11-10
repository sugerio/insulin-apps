export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };
export type Size = { width: number; height: number };

/** Move relative to the point at which the field was grabbed, not its top-left. */
export function moveField(page: Rect, pointer: Point, size: Size, grabOffset: Point): Rect {
  if (![grabOffset.x, grabOffset.y].every(Number.isFinite) || grabOffset.x < 0 || grabOffset.y < 0 || grabOffset.x > size.width || grabOffset.y > size.height) throw new Error('Invalid grab offset');
  return placeField(page, {x: pointer.x - grabOffset.x * page.width, y: pointer.y - grabOffset.y * page.height}, {width: size.width, height: size.height});
}

/** Normalized coordinates are measured from the visible page's top-left. */
export function placeField(page: Rect, pointer: Point, size: Size): Rect {
  const values = [page.x, page.y, page.width, page.height, pointer.x, pointer.y, size.width, size.height];
  if (!values.every(Number.isFinite) || page.width <= 0 || page.height <= 0 || size.width <= 0 || size.height <= 0 || size.width > 1 || size.height > 1) throw new Error('Invalid placement geometry');
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  return { x: clamp((pointer.x - page.x) / page.width, 1 - size.width), y: clamp((pointer.y - page.y) / page.height, 1 - size.height), ...size };
}

/** Baseline editor box: 150 by 34 PDF points, not a promise about signature width. */
export function editorFieldSize(page:Size):Size {
 if(!Number.isFinite(page.width)||!Number.isFinite(page.height)||page.width<150||page.height<34)throw new Error('Page too small for field');
 return {width:150/page.width,height:34/page.height};
}

/** Convert a normalized size between PDF pages, preserving physical points. */
export function sizeOnPage(size:Size,from:Size,to:Size):Size {
 if(![size.width,size.height,from.width,from.height,to.width,to.height].every(Number.isFinite)||Math.min(size.width,size.height,from.width,from.height,to.width,to.height)<=0)throw new Error('Invalid page size');
 const result={width:size.width*from.width/to.width,height:size.height*from.height/to.height};
 if(result.width>1||result.height>1)throw new Error('Page too small for field');return result;
}

/** New fields are grabbed at their center, including at different page scales. */
export function newFieldPlacement(page:Rect,pointer:Point,pdf:Size):Rect {
 const size=editorFieldSize(pdf);
 return moveField(page,pointer,size,{x:size.width/2,y:size.height/2});
}
