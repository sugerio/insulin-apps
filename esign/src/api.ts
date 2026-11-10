import { withSuger } from '@fours/app/server'
import { defineHandler } from 'nitro'
import { openAppD1 } from '#platform'
import { handleAppRequest } from './app/server/router'

// The platform's routes (/api/__suger/*) come from @fours/app; everything else is the app's.
const handle = withSuger(handleAppRequest, { database: openAppD1 })

export default defineHandler((event) => handle(event.req))
