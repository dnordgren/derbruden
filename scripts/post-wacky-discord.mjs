#!/usr/bin/env node
// Posts ONE approved wacky stat to the league Discord via webhook.
//
// Editorial gate is the whole point: this script is only ever run by
// hand, with the exact text Derek approved. It defaults to --dry-run
// (prints the payload, posts nothing); an actual post requires --send.
//
// Usage:
//   node scripts/post-wacky-discord.mjs [--send] "approved stat text"
//   node scripts/post-wacky-discord.mjs [--send] --file=stat.txt
//
// Webhook: DISCORD_WEBHOOK_WACKYSTAT from the environment or
// scripts/.env (git-ignored). The webhook's own name/avatar are
// overridden per message to "Der Bruden Wacky Stat".

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from './lib/espn.mjs'
import { postDiscordMessage } from './lib/discord.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENV_FILE = path.join(__dirname, '.env')
export const WACKY_USERNAME = 'Der Bruden Wacky Stat'
export const DISCORD_MAX_LEN = 2000

export function buildPayload(text) {
  const content = String(text ?? '').trim()
  if (!content) throw new Error('Stat text is empty. Nothing to post.')
  if (content.length > DISCORD_MAX_LEN) {
    throw new Error(`Stat text is ${content.length} characters; Discord's limit is ${DISCORD_MAX_LEN}.`)
  }
  return { username: WACKY_USERNAME, content }
}

export function parseArgs(argv) {
  const args = { send: false, file: null, text: '' }
  const words = []
  for (const arg of argv) {
    if (arg === '--send') args.send = true
    else if (arg === '--dry-run') args.send = false
    else if (arg.startsWith('--file=')) args.file = arg.split('=')[1]
    else if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`)
    else words.push(arg)
  }
  args.text = words.join(' ')
  return args
}

export async function postWackyStat({ text, send = false, fetchImpl = fetch, env = {} }) {
  const payload = buildPayload(text)
  if (!send) return { posted: false, payload }
  const webhook = env.DISCORD_WEBHOOK_WACKYSTAT
  if (!webhook) throw new Error('DISCORD_WEBHOOK_WACKYSTAT is not set (environment or scripts/.env).')
  await postDiscordMessage(fetchImpl, webhook, payload)
  return { posted: true, payload }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const text = args.file ? fs.readFileSync(args.file, 'utf8') : args.text
  const env = resolveConfig(ENV_FILE, ['DISCORD_WEBHOOK_WACKYSTAT'])
  const result = await postWackyStat({ text, send: args.send, env })
  console.log(JSON.stringify(result.payload, null, 2))
  console.log(result.posted ? 'Posted to Discord.' : 'DRY RUN — not posted. Re-run with --send to post.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}
