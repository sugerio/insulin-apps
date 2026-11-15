import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card.tsx";
import { cn } from "@/lib/utils.ts";

// Summary tiles under the cap table's tabs: shadcn/ui cards, a muted label over the value, scrolling sideways with
// arrow buttons when they don't fit.

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
  const arrow = (side: "left" | "right") => {
    const shown = edges[side];
    return (
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className={cn(
          "absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-background shadow-sm",
          side === "left" ? "-left-3" : "-right-3",
          !shown && "pointer-events-none opacity-0",
        )}
        aria-label={side === "left" ? "Scroll tiles left" : "Scroll tiles right"}
        tabIndex={shown ? 0 : -1}
        onClick={() => scroll(side === "left" ? -1 : 1)}
      >
        {side === "left" ? <ChevronLeftIcon /> : <ChevronRightIcon />}
      </Button>
    );
  };
  return (
    <div className="relative">
      {arrow("left")}
      <ul className="no-scrollbar flex gap-3 overflow-x-auto pb-1" ref={strip} onScroll={measure} aria-label={label}>
        {items.map((tile) => (
          <li className="w-56 flex-none" key={tile.label}>
            <Card size="sm" className="h-full gap-1">
              <CardHeader>
                <CardDescription>{tile.label}</CardDescription>
              </CardHeader>
              <CardContent>
                <div data-slot="tile-value" className="text-xl font-semibold tabular-nums">{tile.value}</div>
                {tile.sub ? <div className="mt-0.5 text-xs text-muted-foreground">{tile.sub}</div> : null}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      {arrow("right")}
    </div>
  );
}
