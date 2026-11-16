import { canChange } from '../../components/CollectionParts.tsx'
import { FactList } from '../../components/FactList.tsx'
import type { TabProps } from './CollectionPage.tsx'

// What it knows: every fact as a sentence, searchable, with its source; Looks right and Fix for the collection's editors.

export function KnowsTab({ detail, openSource }: TabProps) {
  return <FactList collection={detail.collection} editor={canChange(detail.role) && detail.can.change} onOpenSource={openSource} />
}
