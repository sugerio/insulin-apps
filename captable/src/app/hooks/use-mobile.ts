import * as React from "react"

// Cap Table: Tailwind's lg (64rem, 1024 px at the default font size), not shadcn's 768 px. Its pages' layouts were made
// for the whole width below 1024 px (where its old sidebar was a drawer), so both navigation levels go into the sheet
// there. The query is the one sidebar.tsx's lg: classes compile to, in rem, so the two still agree when the browser's
// default font size isn't 16 px (window.innerWidth, in px, wouldn't).
const MOBILE_QUERY = "(width < 64rem)"

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY)
    const onChange = () => {
      setIsMobile(mql.matches)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(mql.matches)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
