import type { Bindings } from './env.ts'
import { logError } from './http.ts'
import { callPlatform } from './platform-api.ts'

/**
 * Mail goes through the platform's relay (DESIGN.md §8.2): `POST <SUGER_MAIL_URL>` with the app's token and the
 * organization the mail is for, one recipient per message, over the gateway's service binding. The relay answers 202
 * once it has sent it. Without the relay (the local preview) nothing is sent. Mail never holds a collection's
 * contents beyond its name: no sources, facts or answers, except the question and the reporter's own words in a report.
 *
 * Sending never fails the work that asked for it: a refused or failed message is logged (without its address or
 * text) and dropped.
 */
export interface Message {
  to: string
  subject: string
  text: string
}

const ADDRESS = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$/

/** Sends one message for an organization; true when the relay took it. */
export async function sendMail(env: Bindings, org: string, message: Message, kind: string): Promise<boolean> {
  if (!ADDRESS.test(message.to)) return false
  try {
    const response = await callPlatform(env, 'SUGER_MAIL_URL', {
      method: 'POST',
      headers: { 'x-suger-organization-id': org },
      body: { to: message.to, subject: message.subject.slice(0, 200), text: message.text.slice(0, 20_000) },
    })
    if (!response) return false
    if (response.status !== 202) {
      logError('mail_refused', new Error(`The relay answered ${response.status}`), { org, kind })
      return false
    }
    return true
  } catch (error) {
    logError('mail_failed', error, { org, kind })
    return false
  }
}

/** Sends to several people, one message each. */
export async function sendMailToAll(env: Bindings, org: string, recipients: (string | null)[], message: Omit<Message, 'to'>, kind: string): Promise<number> {
  let sent = 0
  for (const to of new Set(recipients.filter((address): address is string => Boolean(address)))) {
    if (await sendMail(env, org, { ...message, to }, kind)) sent += 1
  }
  return sent
}

const quoted = (name: string) => `“${name}”`
const footer = '\n\nInsulin Knowledge'
const open = (link: string | null, what = 'Open it') => (link ? `\n\n${what}: ${link}` : '')

/**
 * A link to a page of Knowledge, for mail. The app's address is the platform's host with the app's name in front
 * (knowledge.insulinapps.com beside insulinapps.com), read from the mail relay's address the deploy gives the app, so
 * no host is written here. Null without a relay, when no mail is sent anyway.
 */
export function appLink(env: Pick<Bindings, 'SUGER_MAIL_URL'>, path: string): string | null {
  try {
    const relay = new URL(env.SUGER_MAIL_URL ?? '')
    return `${relay.protocol}//knowledge.${relay.host}${path}`
  } catch {
    return null
  }
}

/** The texts Knowledge sends, in plain words. Mail names a collection and links to it, never its contents. */
export const MAIL = {
  sharedWithYou: (by: string, collection: string, role: string, link: string | null) => ({
    subject: `${by} shared ${quoted(collection)} with you`,
    text: `${by} shared ${quoted(collection)} with you as ${role === 'ADMIN' ? 'an Admin' : `an ${role === 'EDITOR' ? 'Editor' : 'Viewer'}`}. Open it to ask it.${open(link)}${footer}`,
  }),
  transferredToYou: (by: string, collection: string, link: string | null) => ({
    subject: `${quoted(collection)} is now yours`,
    text: `${by} transferred ${quoted(collection)} to you. You own it now: you can share it, export it, transfer it or delete it. ${by} stays as an Admin of it.${open(link)}${footer}`,
  }),
  reported: (by: string, collection: string, question: string, note: string, link: string | null) => ({
    subject: `${by} reported an answer in ${quoted(collection)}`,
    text: `${by} reported that an answer in ${quoted(collection)} may be wrong.\n\nQuestion: ${question}${note ? `\nWhat they said: ${note}` : ''}\n\nFix it, or tell them it is right, from Needs attention.${open(link, 'Open Needs attention')}${footer}`,
  }),
  correctedYourFile: (by: string, collection: string, files: string[], link: string | null) => ({
    subject: `${by} corrected an answer from your file in ${quoted(collection)}`,
    text: `${by} corrected an answer in ${quoted(collection)} that came from ${files.map(quoted).join(', ')}, which you added. New questions use the correction; you may want to update the file too.${open(link)}${footer}`,
  }),
  learned: (collection: string, files: number, facts: number | null, link: string | null) => ({
    subject: `${quoted(collection)} learned ${files === 1 ? 'your file' : files > 0 ? `${files} files` : 'your note'}`,
    text: `${quoted(collection)} learned ${files === 1 ? '1 file' : files > 0 ? `${files} files` : 'your note'}${facts ? ` (${facts} new fact${facts === 1 ? '' : 's'})` : ''}. New questions use them now. If something is wrong, go back from its History.${open(link)}${footer}`,
  }),
  restored: (collection: string, documents: number, link: string | null) => ({
    subject: `${quoted(collection)} restored ${documents === 1 ? '1 document' : `${documents} documents`} from an export`,
    text: `${quoted(collection)} started from the export you added: it restored ${documents === 1 ? '1 document' : `${documents} documents`}, with the files it had stopped using and its corrections. New questions use them now.${open(link)}${footer}`,
  }),
  importFailed: (collection: string, reason: string, link: string | null) => ({
    subject: `${quoted(collection)} couldn't learn your files`,
    text: `${reason}\n\nNothing from this import was kept, so ${quoted(collection)} is exactly as it was before. Open its Sources to learn the other files without the one that failed.${open(link, 'Open its Sources')}${footer}`,
  }),
  ownershipMoved: (previous: string, collection: string, why: 'left' | 'viewer', link: string | null) => ({
    subject: `${quoted(collection)} is now yours`,
    text: `${previous} ${why === 'left' ? 'left your organization' : 'can now only read in Knowledge'}, so ${quoted(collection)} is now yours, as an owner of the organization. You can open it and transfer it to someone else.${open(link)}${footer}`,
  }),
  welcomeBack: (shares: number, link: string | null) => ({
    subject: 'Welcome back to Knowledge',
    text: `You're back in your organization. ${shares === 1 ? '1 collection that was shared with you is' : `${shares} collections that were shared with you are`} shared with you again.${open(link, 'Open Knowledge')}${footer}`,
  }),
  deletedByOrgOwner: (by: string, collection: string) => ({
    subject: `${quoted(collection)} was deleted`,
    text: `${by}, an owner of your organization, deleted ${quoted(collection)}. Its files, facts and backups are gone; saved restore points can't be opened and expire within 30 days.${footer}`,
  }),
  nearLimit: (label: string, used: string, limit: string, support: string, link: string | null) => ({
    subject: `Knowledge: 80% of ${label.toLowerCase()} used`,
    text: `Your organization has used ${used} of its ${limit} ${label.toLowerCase()}. ${support} Rules and data shows usage beside each limit.${open(link, 'Open Rules and data')}${footer}`,
  }),
  keepReadyPaused: (collection: string, used: number, limit: number, resets: string, link: string | null) => ({
    subject: `Keep-ready for ${quoted(collection)} is paused`,
    text: `Keep-ready for ${quoted(collection)} is paused: your organization has used ${used} of its ${limit} awake hours this month. It starts again on ${resets}. Questions still wake the collection.${open(link)}${footer}`,
  }),
  importWaits: (collection: string, resets: string, link: string | null) => ({
    subject: `${quoted(collection)} learns your files on ${resets}`,
    text: `Your organization has learned this month's documents, so ${quoted(collection)} learns what you added on ${resets}, by itself. Everything already learned keeps answering.${open(link)}${footer}`,
  }),
  askForMore: (org: string, by: string, note: string, usage: string) => ({
    subject: 'Knowledge: a request for higher limits',
    text: `${by} asks for higher limits for organization ${org}.\n\n${note ? `What they said: ${note}\n\n` : ''}Usage beside each limit:\n${usage}${footer}`,
  }),
}
