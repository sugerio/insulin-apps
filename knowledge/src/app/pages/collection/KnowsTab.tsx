import { canChange } from '../../components/CollectionParts.tsx'
import { FactList } from '../../components/FactList.tsx'
import { Note } from '../../components/Feedback.tsx'
import type { TabProps } from './CollectionPage.tsx'

// What it knows: every fact as a sentence, with its source; Looks right and Fix for the collection's editors. The facts
// come a page at a time, and the search looks through the ones loaded (GET …/facts takes no search words), so it says so.

export function KnowsTab({ detail, openSource }: TabProps) {
  return (
    <div className="flex flex-col gap-3">
      {detail.collection.facts > 0 ? <Note>The search looks through the facts shown here. When there are more, “Show more” at the end of the list adds them.</Note> : null}
      <FactList collection={detail.collection} editor={canChange(detail.role) && detail.can.change} onOpenSource={openSource} />
    </div>
  )
}
