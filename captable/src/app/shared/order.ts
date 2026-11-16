/** An id's runs of digits and of everything else: "PA10-2" is ["PA", "10", "-", "2"]. */
function runs(id: string): string[] {
  return id.match(/\d+|\D+/g) ?? [];
}

/**
 * Display ids in their natural order, in every list and export: CS-2 before CS-10, PA2-1 before PA10-1. Runs of digits
 * compare as whole numbers of any length, the rest by code point (no locale decides the order), and the id itself
 * breaks a tie (CS-01 before CS-1).
 */
export function compareDisplayIds(a: string, b: string): number {
  const left = runs(a);
  const right = runs(b);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const x = left[index]!;
    const y = right[index]!;
    if (x === y) continue;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const nx = x.replace(/^0+(?=\d)/, "");
      const ny = y.replace(/^0+(?=\d)/, "");
      if (nx.length !== ny.length) return nx.length - ny.length;
      if (nx !== ny) return nx < ny ? -1 : 1;
      continue;
    }
    return x < y ? -1 : 1;
  }
  if (left.length !== right.length) return left.length - right.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
