import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon.tsx";

// Summary tiles under the cap table's tabs: label 12 px over an 18 px value, scrolling sideways
// with arrow buttons when they don't fit.

export interface Tile {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}

export function Tiles({ items, label = "Summary" }: { items: readonly Tile[]; label?: string }) {
  const strip = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const element = strip.current;
    if (!element) return;
    const left = element.scrollLeft > 4;
    const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 4;
    setEdges((previous) => (previous.left === left && previous.right === right ? previous : { left, right }));
  }, []);
  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure, items]);
  const scroll = (direction: number) => {
    const element = strip.current;
    element?.scrollBy?.({ left: direction * Math.max(200, element.clientWidth * 0.7), behavior: "smooth" });
  };
  return (
    <div className={`tiles-wrap${edges.left ? " can-left" : ""}${edges.right ? " can-right" : ""}`}>
      <button type="button" className="tiles-arrow left" aria-label="Scroll tiles left" onClick={() => scroll(-1)} tabIndex={edges.left ? 0 : -1}>
        <Icon name="chevLeft" />
      </button>
      <ul className="tiles" ref={strip} onScroll={measure} aria-label={label}>
        {items.map((tile) => (
          <li className="tile" key={tile.label}>
            <div className="tile-l">{tile.label}</div>
            <div className="tile-v">{tile.value}</div>
            {tile.sub ? <div className="tile-s">{tile.sub}</div> : null}
          </li>
        ))}
      </ul>
      <button type="button" className="tiles-arrow right" aria-label="Scroll tiles right" onClick={() => scroll(1)} tabIndex={edges.right ? 0 : -1}>
        <Icon name="chevRight" />
      </button>
    </div>
  );
}
