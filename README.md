# Merge Gateway for DeepSeek Harness

Adds Merge Gateway models to DSH, configured in **Settings → Merge Gateway** instead of a
YAML file.

## Install

Open DeepSeek Harness once, then quit it. This creates the `desktop` profile the CLI needs.

Then install it, either way:

**Settings → Plugins → Add plugin**, paste:

```
https://github.com/Unnidentified/dsh-merge-preset
```

**Or from a terminal:**

```bash
./dsh-merge          # macOS / Linux
.\dsh-merge.ps1      # Windows PowerShell
```

Relaunch DSH when it finishes.

> On Windows, the repo link needs `git` on PATH, which a stock Windows install does not have.
> Use the terminal wrapper there — it downloads a tarball over HTTPS and needs no git.

## Add your key

Settings → **Merge Gateway** → paste the key → **Save key**.

The key goes into the DSH credential store. The page only ever shows *Key set* or *No key* —
the value is never sent back to the browser.

## What you get

| Model | Context | Max output |
|---|---|---|
| `deepseek/deepseek-v4.1-flash-1017` | 1,000,000 | 384,000 |
| `zai/glm-5.3-flash[1m]` | 1,000,000 | 131,072 |

You can add, rename, or remove models on the same page. Turning a provider off hides its
models from the picker.

## A second account

**Add provider** creates another card. Give it a new `id`, a different credential ref such as
`MERGE_GATEWAY_API_KEY_2`, and paste that account's key.

## If models don't appear

Check that the package landed:

- macOS: `ls ~/.dsh/profiles/desktop/node_modules/dsh-merge-preset`
- Windows: `dir "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-merge-preset"`

Then confirm you relaunched DSH. Plugin code loads once at startup.

## Requirements

macOS, Linux, or Windows. A Merge Gateway API key.

MIT licensed.
