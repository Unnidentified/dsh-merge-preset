# dsh-merge-preset

Merge Gateway models for DeepSeek Harness, **preconfigured**. Install it, add one API key,
and DeepSeek V4.1 Flash and GLM-5.3 Flash show up in the model picker — no endpoints, no
model ids, no patch editing.

## Install

```
dsh plugin --profile desktop add github:Unnidentified/dsh-merge-preset
```

That is the whole install. The preset depends on
[`dsh-llm-direct`](https://github.com/Unnidentified/dsh-llm-direct) for the adapter code and
mounts it with the Merge routes already filled in.

> **Do not also install `dsh-llm-direct` as a separate bundle.** This preset supplies the
> plugin row itself. Two entries with one id make the loader reject the whole tree, and
> *every* provider disappears from the picker — not just these.

## Add your API key

Only the key is yours to supply. Pick either route.

**A. Credential file** — survives restarts, no shell setup:

```yaml
# ~/.dsh/.credentials.yaml
version: 1
refs:
  MERGE_GATEWAY_API_KEY: "your-merge-key"
```

**B. Environment variable** — faster for a one-off:

```bash
export MERGE_GATEWAY_API_KEY="your-merge-key"
dsh --profile desktop
```

Either way the key is resolved **on every request** through DSH's credential plane
(`ctx.credentials.resolve`, with the environment as fallback). You do not need to restart
DSH after adding or rotating it — the next call picks it up.

If the key is missing, the turn fails with a named error rather than a silent empty model:

```
dsh-llm-direct: no credential for provider route "merge-direct";
set MERGE_GATEWAY_API_KEY on the Models page or export it
```

## What you get

| Provider id | Model | Context | Max out |
|---|---|---|---|
| `merge-direct` | DeepSeek V4.1 Flash 1017 | 1,000,000 | 384,000 |
| `merge-direct` | GLM-5.3 Flash | 1,000,000 | 131,072 |
| `merge-direct-2` | DeepSeek V4.1 Flash 1017 | 1,000,000 | 384,000 |
| `merge-direct-2` | GLM-5.3 Flash | 1,000,000 | 131,072 |

Reasoning levels `off` / `low` / `medium` / `high` / `xhigh` / `max` are mapped for all of
them. Wire protocol is Anthropic Messages against
`https://api-gateway.merge.dev/v1/anthropic`.

`merge-direct-2` is a second account and uses its own ref. Set
`MERGE_GATEWAY_API_KEY_2` to use it, or leave it unset and ignore that account.

## Changing the models

The preset is a starting point, not a cage. To add a model or change a limit, target the
row from your profile's `cordis.patch.yml`:

```yaml
- id: merge-direct
  config:
    providers:
      merge-direct:
        displayName: Merge Gateway
        apiKeyEnv: MERGE_GATEWAY_API_KEY
        baseURL: https://api-gateway.merge.dev/v1/anthropic
        endpoint: anthropic-messages
        models:
          - id: some/other-model
            name: Some Other Model
            contextWindow: 200000
            maxTokens: 65536
            inputModalities: [text, image]
```

A targeting patch replaces `config` **wholesale** — it is never deep-merged — so copy the
fields you want to keep rather than restating only the one you are changing.

## Why a preset and not a Models-page entry

DSH's Models page writes into the `llm-pi-ai` plugin. These routes register their own
`LlmAdapter` through `ctx.llm.registerAdapter()`, speaking the provider HTTP API directly, so
pi-ai is bypassed entirely and the two coexist. The tradeoff is that the Models page has no
key box for them — which is why the key goes in the credential file or the environment.

## Requirements

- DeepSeek Harness with bundle support (`dsh plugin add`)
- A Merge Gateway API key

MIT licensed.
