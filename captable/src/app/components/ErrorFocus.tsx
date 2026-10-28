import { useEffect, useRef, useState, type ReactNode } from "react";

// Field errors that appear, from the client's checks or from the server, move focus to the first invalid field and
// are announced once (WCAG 3.3.1): "2 fields need attention. Legal name: Legal name is required." Errors are found by
// what the form controls already say about themselves (aria-invalid, aria-describedby), so every form gets this by
// being inside the wrapper. Focus stays where it is if the admin is already on an invalid field.

function invalidControls(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[aria-invalid="true"]')).filter((element) => !element.closest("[hidden]"));
}

function labelOf(control: HTMLElement): string {
  const own = control.getAttribute("aria-label");
  if (own) return own;
  const labels = (control as HTMLInputElement).labels;
  const text = labels?.[0]?.textContent?.replace(/\*$/, "").trim();
  return text || "A field";
}

function errorOf(control: HTMLElement): string {
  const ids = control.getAttribute("aria-describedby")?.split(" ") ?? [];
  const error = ids.map((id) => control.ownerDocument.getElementById(id)).find((element) => element?.className.includes("err"));
  return error?.textContent?.trim() ?? "";
}

/** Wraps a form, a wizard or a dialog body; it adds no box of its own (display: contents). */
export function ErrorFocus({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [summary, setSummary] = useState("");
  useEffect(() => {
    const element = root.current;
    if (!element || typeof MutationObserver === "undefined") return;
    let known = new Set(invalidControls(element));
    const observer = new MutationObserver(() => {
      const now = invalidControls(element);
      const fresh = now.filter((control) => !known.has(control));
      known = new Set(now);
      if (!fresh.length) {
        if (!now.length) setSummary("");
        return;
      }
      const first = now[0]!;
      const active = element.ownerDocument.activeElement;
      const onInvalid = active instanceof HTMLElement && element.contains(active) && active.getAttribute("aria-invalid") === "true";
      if (!onInvalid) first.focus();
      const error = errorOf(first);
      setSummary(`${now.length === 1 ? "1 field needs" : `${now.length} fields need`} attention. ${labelOf(first)}${error ? `: ${error}` : ""}`);
    });
    observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-invalid"] });
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={root} style={{ display: "contents" }}>
      {summary ? <div className="sr-only" role="alert" data-error-summary="">{summary}</div> : null}
      {children}
    </div>
  );
}
