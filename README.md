# dsh-merge-preset

Merge Gateway models for DeepSeek Harness, **preconfigured**. Install it, add one API key,
and DeepSeek V4.1 Flash and GLM-5.3 Flash show up in the model picker — no endpoints, no
model ids, no patch editing.

## Install

Two bundles, in this order:

```bash
dsh plugin --profile desktop add github:Unnidentified/dsh-llm-direct
dsh plugin --profile desktop add github:Unnidentified/dsh-merge-preset
```

The first supplies the adapter code and mounts its own empty `llm-direct` row (no config, so
it registers no providers). The second mounts the `merge-direct` row, pointing at that same
adapter with the Merge providers already filled in.

`dsh-llm-direct` is a **peer** dependency rather than a dependency: a git-hosted bundle
cannot pull another git package as a subdependency (`ERR_PNPM_EXOTIC_SUBDEP`). Installing
both explicitly is the supported path. They use different row ids, so the loader never sees a
duplicate.

### Or run the installer

A cross-platform installer does both installs, resolves the launcher path, and can store the
key - merging into an existing credentials file rather than replacing it:

```bash
node install.mjs --key sk-your-merge-key
```

On Windows, `node` ships with the DSH app, so no separate Node install is required. Pass
`--profile web` to target a different profile.

### If `dsh` is not on your PATH

The launcher ships inside the app and is only linked onto `PATH` if you enable the CLI during
setup. If `dsh` is not found, run it by full path.

macOS:

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add github:Unnidentified/dsh-llm-direct
"$DSH" plugin --profile desktop add github:Unnidentified/dsh-merge-preset
```

Windows PowerShell:

```powershell
$DSH = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $DSH plugin --profile desktop add github:Unnidentified/dsh-llm-direct
& $DSH plugin --profile desktop add github:Unnidentified/dsh-merge-preset
```

### The `desktop` profile must exist first

`--profile desktop` is created by launching the desktop app once. On a brand-new install the
CLI answers:

```
dsh: Error: Open DeepSeek Harness Desktop once to initialize its profile,
then fully quit it before running dsh plugin --profile desktop.
```

So: **open the app once, quit it fully, then run the two commands.** (`--profile web`
auto-creates itself and needs no prior launch, if you prefer that surface.)

## Add your API key

Only the key is yours to supply. Pick either route.

**A. Credential file** - survives restarts, no shell setup. The path is the DSH home
directory, which is `%USERPROFILE%\.dsh\` on Windows and `~/.dsh/` on macOS/Linux:

```yaml
# macOS / Linux:  ~/.dsh/.credentials.yaml
# Windows:        C:\Users\<you>\.dsh\.credentials.yaml
version: 1
refs:
  MERGE_GATEWAY_API_KEY: "your-merge-key"
```

If that file already exists, **add the `refs` entry** rather than replacing the file - it
holds your other credentials (DeepSeek account, browser session) too.

**B. Environment variable** - faster for a one-off:

macOS / Linux:

```bash
export MERGE_GATEWAY_API_KEY="your-merge-key"
```

Windows PowerShell:

```powershell
$env:MERGE_GATEWAY_API_KEY = "your-merge-key"
```

Windows `cmd.exe`:

```bat
set MERGE_GATEWAY_API_KEY=your-merge-key
```

Either way the key is resolved **on every request** through DSH's credential plane
(`ctx.credentials.resolve`, with `process.env` as fallback), so adding or rotating it needs
no restart - the next call picks it up.

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
- macOS, Linux, or Windows. The adapter itself is platform-neutral: it uses `fetch` and
  `process.env`, and touches no filesystem paths. The installer is Node so it runs on all
  three without a POSIX shell.

MIT licensed.
