/**
 * The read client.
 *
 * One client for the whole site, created lazily. `createClient` opens no socket
 * and performs no handshake - it is a transport wrapper - but building it at
 * module load would run `readNetwork()` during import and turn a bad
 * `VITE_GENLAYER_NETWORK` into a blank page instead of an error the UI can show.
 *
 * There is no account here on purpose. Every view the site renders is a
 * `@gl.public.view` call, which the node answers without a signature, so the
 * registry loads for a visitor who has never connected a wallet. Writing is a
 * separate concern with a separate client (`wallet.ts`), and nothing on the read
 * path can be made to send a transaction by accident.
 */

import { createClient } from 'genlayer-js'
import type { GenLayerClient } from 'genlayer-js/types'

import { CHAIN } from './config'

let cached: GenLayerClient<typeof CHAIN> | null = null

export function readClient(): GenLayerClient<typeof CHAIN> {
  if (cached === null) {
    cached = createClient({ chain: CHAIN })
  }
  return cached
}
