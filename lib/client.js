/**
 * Merge Gateway preset — browser half.
 *
 * A Settings page in the host's own style: one card per provider, a key field
 * that shows only whether a key is stored (never the value), and per-model rows
 * the user can enable, rename, or drop. Everything saves through the Host half
 * over the `/merge-preset` channel, so the page never touches files.
 *
 * Styling uses `--dsw-alias-*` tokens only, so it follows light/dark and any
 * theme override without a colour of its own.
 *
 * @module dsh-merge-preset/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-merge-preset',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const CHANNEL = '/merge-preset'

    const CSS = `
.mg-root { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 20px; }
.mg-card {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px; padding: 14px 16px;
  background: var(--dsw-alias-bg-layer-1);
  display: flex; flex-direction: column; gap: 10px;
}
.mg-row { display: flex; align-items: center; gap: 10px; }
.mg-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.mg-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mg-field { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 0; }
.mg-label { font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.mg-input {
  width: 100%; box-sizing: border-box;
  padding: 7px 9px; font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px;
}
.mg-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.mg-btn {
  padding: 6px 12px; font-size: 12px; font-weight: 500;
  border-radius: 7px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.mg-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.mg-btn:disabled { opacity: .5; cursor: default; }
.mg-btn-primary {
  background: var(--dsw-alias-button-primary-fill);
  border-color: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary);
}
.mg-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.mg-pill {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}
.mg-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.mg-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.mg-err { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.mg-model {
  display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px;
  align-items: end; padding: 8px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.mg-switch {
  appearance: none; width: 34px; height: 20px; border-radius: 999px;
  background: var(--dsw-alias-border-l2); position: relative; cursor: pointer;
  border: none; flex: none;
}
.mg-switch::after {
  content: ''; position: absolute; top: 2px; left: 2px;
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-bg-base); transition: transform .15s ease;
}
.mg-switch:checked { background: var(--dsw-alias-brand-primary); }
.mg-switch:checked::after { transform: translateX(14px); }
.mg-sep { height: 1px; background: var(--dsw-alias-border-l1); }
.mg-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); font-style: italic; }
`

    // The plugin ctx arrives in apply(); the components below run later, so they
    // read it from this slot rather than closing over a value that does not exist
    // yet at factory time.
    let pluginCtx

    /** One call to the Host half. Throws on a transport or handler failure. */
    const call = async (method, payload) => {
      if (pluginCtx === undefined) throw new Error('Merge settings are not mounted yet')
      const connection = pluginCtx.get('connection')
      const reply = await connection.rpc.call(CHANNEL, method, payload ?? {})
      if (!reply?.ok) throw new Error(reply?.error?.message ?? 'request failed')
      return reply.value
    }

    function ProviderCard({ row, index, onPatch, onRemove, onSetKey, onClearKey, busy }) {
      const [keyDraft, setKeyDraft] = useState('')

      const save = async () => {
        try {
          await onSetKey(row.apiKeyEnv, keyDraft)
          setKeyDraft('')
        } catch {
          /* the parent surfaces the error */
        }
      }

      return h('div', { className: 'mg-card' }, [
        h('div', { key: 'head', className: 'mg-row' }, [
          h('input', {
            key: 'sw',
            type: 'checkbox',
            className: 'mg-switch',
            checked: row.enabled !== false,
            onChange: (e) => onPatch(index, { enabled: e.target.checked }),
            'aria-label': 'Enable this provider',
          }),
          h('div', { key: 'n', className: 'mg-field' }, [
            h('div', { key: 't', className: 'mg-title' }, row.displayName || row.id),
            h('div', { key: 's', className: 'mg-sub' }, `${row.models?.length ?? 0} models · ${row.id}`),
          ]),
          h('span', {
            key: 'k',
            className: `mg-pill ${row.keyConfigured ? 'mg-ok' : 'mg-warn'}`,
          }, row.keyConfigured ? 'Key set' : 'No key'),
          h('button', {
            key: 'rm',
            className: 'mg-btn',
            onClick: () => onRemove(index),
            title: 'Remove this provider',
          }, 'Remove'),
        ]),

        h('div', { key: 'fields', className: 'mg-row' }, [
          h('label', { key: 'dn', className: 'mg-field' }, [
            h('span', { key: 'l', className: 'mg-label' }, 'Display name'),
            h('input', {
              key: 'i',
              className: 'mg-input',
              value: row.displayName ?? '',
              onChange: (e) => onPatch(index, { displayName: e.target.value }),
            }),
          ]),
          h('label', { key: 'bu', className: 'mg-field' }, [
            h('span', { key: 'l', className: 'mg-label' }, 'Base URL'),
            h('input', {
              key: 'i',
              className: 'mg-input',
              value: row.baseURL ?? '',
              onChange: (e) => onPatch(index, { baseURL: e.target.value }),
            }),
          ]),
        ]),

        h('div', { key: 'key', className: 'mg-row' }, [
          h('label', { key: 'kr', className: 'mg-field' }, [
            h('span', { key: 'l', className: 'mg-label' }, `API key (credential ref: ${row.apiKeyEnv})`),
            h('input', {
              key: 'i',
              className: 'mg-input',
              type: 'password',
              placeholder: row.keyConfigured ? '•••••••• (stored — type to replace)' : 'Paste your Merge API key',
              value: keyDraft,
              onChange: (e) => setKeyDraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && keyDraft.trim()) save()
              },
            }),
          ]),
          h('button', {
            key: 'sb',
            className: 'mg-btn mg-btn-primary',
            disabled: busy || !keyDraft.trim(),
            onClick: save,
          }, 'Save key'),
          row.keyConfigured
            ? h('button', {
                key: 'cb',
                className: 'mg-btn',
                disabled: busy,
                onClick: () => onClearKey(row.apiKeyEnv),
              }, 'Clear')
            : null,
        ]),

        h('div', { key: 'sep', className: 'mg-sep' }),
        h('div', { key: 'ml', className: 'mg-label' }, 'Models'),
        (row.models ?? []).length === 0
          ? h('div', { key: 'me', className: 'mg-empty' }, 'No models yet — add one below.')
          : (row.models ?? []).map((m, mi) =>
              h('div', { key: `m${mi}`, className: 'mg-model' }, [
                h('label', { key: 'id', className: 'mg-field' }, [
                  h('span', { key: 'l', className: 'mg-label' }, 'Model id'),
                  h('input', {
                    key: 'i',
                    className: 'mg-input',
                    value: m.id ?? '',
                    onChange: (e) => {
                      const models = [...(row.models ?? [])]
                      models[mi] = { ...models[mi], id: e.target.value }
                      onPatch(index, { models })
                    },
                  }),
                ]),
                h('label', { key: 'nm', className: 'mg-field' }, [
                  h('span', { key: 'l', className: 'mg-label' }, 'Label in picker'),
                  h('input', {
                    key: 'i',
                    className: 'mg-input',
                    value: m.name ?? '',
                    onChange: (e) => {
                      const models = [...(row.models ?? [])]
                      models[mi] = { ...models[mi], name: e.target.value }
                      onPatch(index, { models })
                    },
                  }),
                ]),
                h('button', {
                  key: 'x',
                  className: 'mg-btn',
                  title: 'Remove model',
                  onClick: () => {
                    const models = [...(row.models ?? [])]
                    models.splice(mi, 1)
                    onPatch(index, { models })
                  },
                }, '×'),
              ]),
            ),
        h('button', {
          key: 'add',
          className: 'mg-btn',
          onClick: () => {
            const models = [...(row.models ?? []), { id: '', name: '', contextWindow: 1000000, maxTokens: 131072 }]
            onPatch(index, { models })
          },
        }, '+ Add model'),
      ])
    }

    function MergeSettings() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [dirty, setDirty] = useState(false)

      const load = useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          setState(await call('state'))
          setDirty(false)
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => { load() }, [load])

      const patch = (i, change) => {
        setState((s) => {
          if (!s) return s
          const providers = [...s.providers]
          providers[i] = { ...providers[i], ...change }
          return { ...s, providers }
        })
        setDirty(true)
      }

      const remove = (i) => {
        setState((s) => {
          if (!s) return s
          const providers = [...s.providers]
          providers.splice(i, 1)
          return { ...s, providers }
        })
        setDirty(true)
      }

      const addProvider = () => {
        setState((s) => ({
          ...(s ?? { providers: [] }),
          providers: [
            ...(s?.providers ?? []),
            {
              id: `merge-${(s?.providers?.length ?? 0) + 1}`,
              displayName: 'Merge Gateway',
              apiKeyEnv: 'MERGE_GATEWAY_API_KEY',
              baseURL: 'https://api-gateway.merge.dev/v1/anthropic',
              enabled: true,
              models: [],
            },
          ],
        }))
        setDirty(true)
      }

      const save = async () => {
        setBusy(true)
        setError('')
        try {
          const next = await call('save', { providers: state?.providers ?? [] })
          setState(next)
          setDirty(false)
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }

      const setKey = async (ref, value) => {
        setBusy(true)
        setError('')
        try {
          setState(await call('setKey', { ref, value }))
        } catch (e) {
          setError(String(e?.message ?? e))
          throw e
        } finally {
          setBusy(false)
        }
      }

      const clearKey = async (ref) => {
        setBusy(true)
        setError('')
        try {
          setState(await call('clearKey', { ref }))
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }

      if (state === null) {
        return h('div', { className: 'mg-root' },
          error ? h('div', { className: 'mg-err' }, error) : h('div', { className: 'mg-sub' }, 'Loading…'))
      }

      return h('div', { className: 'mg-root' }, [
        h('div', { key: 'hdr', className: 'mg-sub' },
          'Merge Gateway routes for the built-in LLM adapter. Keys are stored in the DSH credential store and never shown again.'),

        error ? h('div', { key: 'err', className: 'mg-err' }, error) : null,

        ...(state.providers ?? []).map((row, i) =>
          h(ProviderCard, {
            key: row.id || i,
            row, index: i,
            onPatch: patch,
            onRemove: remove,
            onSetKey: setKey,
            onClearKey: clearKey,
            busy,
          })),

        h('div', { key: 'actions', className: 'mg-row' }, [
          h('button', { key: 'a', className: 'mg-btn', onClick: addProvider, disabled: busy }, '+ Add provider'),
          h('div', { key: 'sp', style: { flex: 1 } }),
          h('button', {
            key: 's',
            className: 'mg-btn mg-btn-primary',
            onClick: save,
            disabled: busy || !dirty,
          }, dirty ? 'Save changes' : 'Saved'),
        ]),
      ])
    }

    // The loader takes the factory's RETURN value as the plugin, so the shape
    // below is returned rather than assigned to `module.exports`: a factory
    // receives `require` only, and `module` is not in scope here.
    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        pluginCtx = ctx
        // No `styles` global in a bundle module (that belongs to dynamic
        // packages): own the <style> element here and remove it on dispose.
        ctx.effect(() => {
          const el = document.createElement('style')
          el.setAttribute('data-dsh-merge-preset', '')
          el.textContent = CSS
          document.head.appendChild(el)
          return () => { el.remove() }
        }, 'dsh-merge-preset: styles')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'merge-preset',
          order: 12,
          label: 'Merge Gateway',
        }, MergeSettings))
      },
    }
  },
})
