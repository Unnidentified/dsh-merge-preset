# dsh-merge-preset

Merge Gateway models for DeepSeek Harness, configured from a **Settings page** — no
YAML editing, no credential-file surgery.



## Install

There are **two packages**, and both are required:

| Package | What it is |
|---|---|
| `dsh-llm-direct` | the adapter — speaks the provider HTTP API |
| `dsh-merge-preset` | this preset — mounts the adapter and adds the Settings page |

Install the adapter **first**, then the preset.

### Step 0 — initialize the profile

`--profile desktop` is created by the app, not the CLI. **Open DeepSeek Harness once, then
quit it completely** (including the tray/menu-bar icon). Skip this and you get:

```
dsh: Error: Open DeepSeek Harness Desktop once to initialize its profile,
then fully quit it before running dsh plugin --profile desktop.
```

### macOS

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add https://github.com/Unnidentified/dsh-llm-direct/archive/refs/tags/v0.1.1.tar.gz
"$DSH" plugin --profile desktop add https://github.com/Unnidentified/dsh-merge-preset/archive/refs/tags/v0.2.1.tar.gz
```

### Windows (PowerShell)

```powershell
$DSH = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $DSH plugin --profile desktop add https://github.com/Unnidentified/dsh-llm-direct/archive/refs/tags/v0.1.1.tar.gz
& $DSH plugin --profile desktop add https://github.com/Unnidentified/dsh-merge-preset/archive/refs/tags/v0.2.1.tar.gz
```

PowerShell needs `$DSH = "..."` and the call operator `&`. The macOS lines (`DSH="..."` then
`"$DSH" ...`) are bash and fail in PowerShell with `Unexpected token 'plugin'`.

### Windows (cmd.exe)

```bat
set "DSH=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
"%DSH%" plugin --profile desktop add https://github.com/Unnidentified/dsh-llm-direct/archive/refs/tags/v0.1.1.tar.gz
"%DSH%" plugin --profile desktop add https://github.com/Unnidentified/dsh-merge-preset/archive/refs/tags/v0.2.1.tar.gz
```

### If models still do not appear

Check that all three landed in the profile:

- macOS: `ls ~/.dsh/profiles/desktop/node_modules | grep dsh-`
- Windows: `dir "%USERPROFILE%\.dsh\profiles\desktop\node_modules" | findstr dsh-`

You want `dsh-llm-direct`, `dsh-merge-preset`, and `@deepseek-ai\schemastery`. The last one is
the schema library both packages import; a real DSH profile hoists it because its
`pnpm-workspace.yaml` sets `nodeLinker: hoisted`.

### Then relaunch

Quit and reopen DSH. Plugin code loads once at startup, so a running app keeps the previous
model list until it restarts.

### Why tarball URLs, and not the repo link

Do **not** paste the GitHub repo URL into the plugin installer. Two reasons, both verified:

- **Windows has no git by default.** A repo spec makes pnpm run `git ls-remote`, which fails
  with `'git' is not recognized as an internal or external command`.
- **The repo installs only one package.** A repo link for this preset pulls the preset alone;
  `dsh-llm-direct` is a peer and is *not* installed with it, so the adapter import fails and
  **no models appear** — while the install still reports success.

The `…/archive/refs/tags/<tag>.tar.gz` URL downloads over HTTPS with no git, on any platform.

## Configure it in the UI

Open **Settings → Merge Gateway**. You get:

- A card per provider with a **display name**, **base URL**, and an enable switch.
- An **API key field**. Paste the key and press *Save key*; it goes straight to the DSH
  credential store. The page only ever shows *Key set* or *No key* — the value is never read
  back into the browser.
- **Model rows**: edit the model id and the label that appears in the picker, remove a model,
  or add one.
- *Save changes* persists the provider list; the adapter remounts with the new rows.

Turning a provider **off** removes its models from the picker entirely, so a second account
with no key never shows models that fail on selection.

## Models included on first run

| Provider | Model id | Context | Max out |
|---|---|---|---|
| `merge` | `deepseek/deepseek-v4.1-flash-1017` | 1,000,000 | 384,000 |
| `merge` | `zai/glm-5.3-flash[1m]` | 1,000,000 | 131,072 |

Reasoning levels `off`/`low`/`medium`/`high`/`xhigh`/`max` are mapped for both. Wire protocol
is Anthropic Messages against `https://api-gateway.merge.dev/v1/anthropic`.

## Adding a second account

*Add provider* creates a new card. Give it a distinct `id`, point `apiKeyEnv` at a second
credential ref (for example `MERGE_GATEWAY_API_KEY_2`), paste that account's key, and save.

## Requirements

- DeepSeek Harness with bundle support (`dsh plugin add`)
- A Merge Gateway API key
- macOS, Linux, or Windows. The adapter is platform-neutral (`fetch` + `process.env`, no
  filesystem paths), and the Settings page is ordinary React in the host's theme tokens.

## Why the install is two packages

`dsh-llm-direct` is the adapter — the code that speaks the provider HTTP APIs. This preset is
configuration plus UI. Splitting them means the adapter can be reused for other
Anthropic-compatible gateways without dragging a Merge-specific settings page along.

MIT licensed.
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

## One account or two

The preset preconfigures **two** providers: `merge-direct` on `MERGE_GATEWAY_API_KEY` and
`merge-direct-2` on `MERGE_GATEWAY_API_KEY_2`. If you only have one Merge key, set only that
one ref - but the models of the *other* account still appear in the picker and fail when you
select them.

To avoid that, replace the row with a single provider. Target `merge-direct` from your
profile's `cordis.patch.yml`:

```yaml
- id: merge-direct
  config:
    providers:
      merge:
        displayName: Merge Gateway
        apiKeyEnv: MERGE_GATEWAY_API_KEY_2   # whichever ref holds your key
        baseURL: https://api-gateway.merge.dev/v1/anthropic
        endpoint: anthropic-messages
        models:
          - id: deepseek/deepseek-v4.1-flash-1017
            name: DeepSeek V4.1 Flash (Merge)
            contextWindow: 1000000
            maxTokens: 384000
            inputModalities: [text, image]
```

A targeting patch replaces the preset's whole `config`, leaving exactly one provider.

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
