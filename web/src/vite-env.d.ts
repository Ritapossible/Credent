/// <reference types="vite/client" />

/**
 * The build-time configuration, declared so `chain/config.ts` reads it against a
 * type instead of `any`. Both are optional: `VITE_GENLAYER_NETWORK` falls back
 * to studionet, and an absent `VITE_CONTRACT_ADDRESS` is the legitimate
 * "not deployed yet" state the UI reports rather than throws on.
 *
 * Merged into Vite's own `ImportMetaEnv`, which keeps `MODE`, `DEV` and the rest.
 * See `.env.example` for what each one means and where it has to be set.
 */
interface ImportMetaEnv {
  readonly VITE_CONTRACT_ADDRESS?: string
  readonly VITE_GENLAYER_NETWORK?: string
}
