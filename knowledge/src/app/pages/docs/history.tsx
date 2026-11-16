import { DocLink, DocTable, InApp, type DocTopic } from './parts.tsx'

// Docs › History and going back: restore points, going back (explained first), undo, and why a restore point can't
// be brought back (the engine contract's NotRestorableReason). It follows routes/history.ts.

export const history: DocTopic = {
  slug: 'history',
  title: 'History and going back',
  summary: 'Every change saves a restore point: go back to an earlier version, undo it, and see why an old version may not come back.',
  group: 'app',
  sections: [
    {
      id: 'restore-points',
      title: 'Restore points',
      body: (
        <>
          <p>
            Every change to what a collection knows saves a <b>restore point</b> automatically: files and web pages added, notes,
            corrections, a file stopped or used again, going back. A collection's <b>History</b> lists them, newest first, with
            when each was saved, what changed and how many documents it held. Changes made within 5 minutes of each other
            share one restore point, so a few quick changes come back, or are taken back, together. Restore points are kept 30
            days.
          </p>
          <p>
            Sharing and settings aren't part of a restore point: who has access never changes by going back.
          </p>
        </>
      ),
    },
    {
      id: 'go-back',
      title: 'Go back to an earlier version',
      body: (
        <>
          <p>
            The collection's owner, admins and editors can choose <b>Go back to this version</b> on an earlier restore point.
            Before anything happens, Knowledge explains what it will do:
          </p>
          <ul>
            <li>what the collection will know: the documents it held then;</li>
            <li>which files added later will be <b>set aside, not deleted</b>, so you can add them again from Sources;</li>
            <li>how many corrections made later will be undone too.</li>
          </ul>
          <p>
            Going back takes about a minute, and questions wait for a moment meanwhile. Then the collection answers from that
            version, and going back is itself a new restore point.
          </p>
        </>
      ),
    },
    {
      id: 'undo',
      title: 'Undo',
      body: (
        <p>
          After going back, <b>Undo</b> in History brings everything back as it was before. Because going back never deletes
          files, nothing is lost either way.
        </p>
      ),
    },
    {
      id: 'versions-that-cant-come-back',
      title: "Versions that can't be brought back",
      body: (
        <>
          <p>History says when a restore point can't be brought back, and why:</p>
          <DocTable
            label="Why a restore point can't be brought back"
            columns={['Reason', 'What it means']}
            rows={[
              ['A file was removed for good', <>A file it held was removed for good after it, so no earlier version can bring that file back. See <DocLink to="collections-and-sources" section="stop-using-or-remove">Stop using, or remove for good</DocLink>.</>],
              ['Expired', 'Restore points last 30 days.'],
              ['Upgraded', 'Insulin Knowledge was upgraded since it was saved, and that version can no longer be opened. The collection itself came across from its latest backup.'],
              ['Newly hidden', 'It holds text that a stricter hiding rule now hides. See Hiding personal data.'],
              ['Damaged', 'It was found damaged when Insulin checked it, twice.'],
            ]}
          />
        </>
      ),
    },
    {
      id: 'backups',
      title: 'Backups',
      body: (
        <>
          <p>
            Besides restore points, every collection is backed up daily. Daily backups are kept for your organization's days of
            daily backups (30 by default; History's footer and Health say how many), and the latest one as long as the collection
            exists, so a collection is never lost by sitting unused. See <DocLink to="your-data">Your data</DocLink>.
          </p>
          <InApp>A collection › History: Go back to this version, then Undo. Admins see each collection's last restore point and last backup on Health.</InApp>
        </>
      ),
    },
  ],
}
