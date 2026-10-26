/**
 * Merge Gateway preset — Host half.
 *
 * Two jobs:
 *
 * 1. Mount the `dsh-llm-direct` adapter with this preset's provider rows, so a
 *    single install produces a working model list.
 * 2. Serve the Settings page over a private RPC channel: read the rows, save an
 *    edited list, and store or clear the API key.
 *
 * Both jobs read one mutable `rows` array, which is the point: the row the
 * adapter mounts and the row the page edits cannot drift apart, because they
 * are the same objects. A YAML patch could not offer that.
 *
 * @module dsh-merge-preset
 */
import z from '@deepseek-ai/schemastery'
import * as adapter from './adapter.js'
import { mountChannel } from './route.js'

export const name = 'merge-preset'

/** The channel the browser half calls; must match `lib/client.js`. */
const CHANNEL = '/merge-preset'

/** Reasoning map shared by every Merge route; Anthropic has no effort string. */
const EFFORTS = { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }

const DEFAULT_BASE = 'https://api-gateway.merge.dev/v1/anthropic'

/** A first-run row, so a fresh install has a usable model list before any edit. */
const FIRST_RUN = [
  {
    id: 'merge',
    displayName: 'Merge Gateway',
    apiKeyEnv: 'MERGE_GATEWAY_API_KEY',
    baseURL: DEFAULT_BASE,
    enabled: true,
    models: [
      { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash', contextWindow: 1000000, maxTokens: 384000 },
      { id: 'zai/glm-5.3-flash[1m]', name: 'GLM-5.3 Flash', contextWindow: 1000000, maxTokens: 131072 },
    ],
  },
]

const Model = z.object({
  id: z.string().required(),
  name: z.string().default(''),
  contextWindow: z.number().step(1).min(1).default(1000000),
  maxTokens: z.number().step(1).min(1).default(131072),
})

const Provider = z.object({
  id: z.string().required(),
  displayName: z.string().default('Merge Gateway'),
  apiKeyEnv: z.string().required(),
  baseURL: z.string().default(DEFAULT_BASE),
  enabled: z.boolean().default(true),
  models: z.array(Model).default([]),
})

export const Config = z.object({
  providers: z.array(Provider).default(FIRST_RUN),
  /**
   * Declare this preset's own provider row. A bundle that already declares the
   * same Merge providers through `llm-direct` sets this to `false`, so the model
   * picker shows one group per account instead of a third, unpinned
   * "Merge Gateway" group shadowing them.
   */
  mountAdapter: z.boolean().default(true),
})

/**
 * Project the page-facing rows onto the adapter config.
 *
 * Disabled rows are omitted rather than mounted-but-empty: a row whose key ref
 * is unset would otherwise put models in the picker that fail on selection.
 *
 * @param rows - configured provider rows.
 * @returns provider map for `dsh-llm-direct`.
 */
function toAdapter(rows) {
  const out = {}
  for (const row of rows ?? []) {
    if (row?.enabled === false) continue
    if (!row?.id || !row?.apiKeyEnv) continue
    out[row.id] = {
      displayName: row.displayName || row.id,
      apiKeyEnv: row.apiKeyEnv,
      baseURL: row.baseURL || DEFAULT_BASE,
      endpoint: 'anthropic-messages',
      reasoning: 'high',
      contextWindow: 1000000,
      defaultMaxTokens: 131072,
      cacheControl: 'none',
      reasoningEfforts: EFFORTS,
      models: (row.models ?? [])
        .filter((m) => m?.id)
        .map((m) => ({
          id: m.id,
          name: m.name || m.id,
          contextWindow: m.contextWindow ?? 1000000,
          maxTokens: m.maxTokens ?? 131072,
          inputModalities: ['text', 'image'],
          reasoningEfforts: EFFORTS,
        })),
    }
  }
  return out
}

/**
 * @param ctx - the plugin's own context.
 * @param config - validated provider rows.
 */
export function apply(ctx, config) {
  const rows = [...(config?.providers?.length ? config.providers : FIRST_RUN)]

  // The adapter ships inside this package, so one install is enough. It rides a
  // child fiber and is disposed with this plugin.
  //
  // Skipped when another bundle layer already declares these providers: two
  // rows serving the same account would put duplicate model groups in the
  // picker, and the settings page would edit a row the adapter never reads.
  if (config?.mountAdapter !== false) {
    ctx.inject(['llm'], (llm) => {
      llm.plugin(adapter, { providers: toAdapter(rows) })
    })
  }

  // --- Settings page channel ---------------------------------------------
  ctx.inject(['connection', 'credentialsController'], (inner) => {
    const credentials = inner.credentialsController
    const llm = inner.get('llm')

    /** Rows plus each row's key state; the page renders from this alone. */
    const state = async () => {
      const refs = rows.map((r) => r.apiKeyEnv).filter(Boolean)
      let described = {}
      if (refs.length > 0) {
        try {
          described = await credentials.describe(refs)
        } catch {
          // No credential provider mounted: rows read as unconfigured rather
          // than the page refusing to open.
          described = {}
        }
      }
      // What the picker is actually being fed. Read from the live LLM service
      // rather than from this plugin's own config, because when another bundle
      // layer declares the providers this row's config is not what mounts.
      //
      // `listProviders` answers only `{ id, name }`; the catalog is a separate
      // async call per route. Vendors are not part of the public catalog either,
      // so they come from this plugin's own rows when the ids line up, and read
      // as unpinned otherwise rather than being invented.
      let mounted = []
      try {
        const live = (llm?.listProviders?.() ?? []).filter((p) => /^merge/i.test(String(p?.id ?? '')))
        mounted = await Promise.all(
          live.map(async (p) => {
            const id = String(p.id ?? '')
            let models = []
            try {
              // The catalog is `{ id, name, description?, inputModalities? }` and
              // nothing else: llm validates the list and rebuilds each entry, so
              // a vendor pin is not observable from here and is not invented.
              models = (await llm.listModels(id)).map((m) => ({
                id: String(m?.id ?? ''),
                name: String(m?.name ?? m?.id ?? ''),
                image: Array.isArray(m?.inputModalities) && m.inputModalities.includes('image'),
              }))
            } catch {
              models = []
            }
            return { id, displayName: String(p.name ?? id), models }
          }),
        )
      } catch {
        mounted = []
      }

      return {
        providers: rows.map((r) => ({ ...r, keyConfigured: Boolean(described?.[r.apiKeyEnv]?.configured) })),
        // When the adapter is not mounted, the model rows on this page are
        // inert: another bundle layer declares the providers. The page says so
        // rather than offering edits that change nothing.
        mountsAdapter: config?.mountAdapter !== false,
        mounted,
      }
    }

    mountChannel(inner, async (method, payload) => {
      switch (method) {
        case 'state':
          return { ok: true, value: await state() }

        case 'save': {
          const next = Config(payload ?? {})
          rows.length = 0
          rows.push(...(next.providers.length ? next.providers : FIRST_RUN))
          return { ok: true, value: await state() }
        }

        case 'setKey': {
          const ref = payload?.ref
          const value = payload?.value
          if (typeof ref !== 'string' || ref.length === 0) throw new Error('setKey needs a ref')
          if (typeof value !== 'string' || value.length === 0) throw new Error('setKey needs a non-empty value')
          await credentials.set(ref, value)
          return { ok: true, value: await state() }
        }

        case 'clearKey': {
          const ref = payload?.ref
          if (typeof ref !== 'string' || ref.length === 0) throw new Error('clearKey needs a ref')
          await credentials.unset(ref)
          return { ok: true, value: await state() }
        }

        default:
          throw new Error(`unknown method: ${String(method)}`)
      }
    })
  })
}
