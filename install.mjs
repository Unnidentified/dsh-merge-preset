#!/usr/bin/env node
/**
 * Install the Merge preset into a DSH profile, on macOS, Linux, or Windows.
 *
 * Node is used instead of a shell script because the DSH app bundles a Node
 * binary that exists on every supported platform, while `bash` does not exist
 * on a stock Windows install.
 *
 *   node install.mjs                  # desktop profile
 *   node install.mjs --profile web    # another profile
 *   node install.mjs --key sk-...     # also store the API key
 *
 * Idempotent: re-running adds nothing twice, and an existing credentials file
 * is merged into rather than replaced.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { platform } from 'node:process'

const PACKAGES = [
  'github:Unnidentified/dsh-llm-direct',
  'github:Unnidentified/dsh-merge-preset',
]

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}

const profile = flag('profile', 'desktop')
const apiKey = flag('key', undefined)
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** Absolute paths the launcher may live at, per platform, in preference order. */
function candidateLaunchers() {
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return [
      join(local, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
      join(local, 'Programs', 'deepseek-harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    ]
  }
  if (platform === 'darwin') {
    return [
      '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
      join(homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'),
    ]
  }
  return [
    '/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh',
    '/usr/local/bin/dsh',
    '/usr/bin/dsh',
  ]
}

/** The launcher to use: `dsh` on PATH if it works, else a full path. */
function resolveLauncher() {
  const probe = spawnSync('dsh', ['--version'], { encoding: 'utf8', shell: platform === 'win32' })
  if (probe.status === 0) return 'dsh'
  for (const candidate of candidateLaunchers()) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Run the launcher with args, returning its exit status. */
function run(launcher, args) {
  // A .cmd launcher on Windows needs a shell; elsewhere exec directly so the
  // path is passed literally.
  const useShell = platform === 'win32' && /\.cmd$/i.test(launcher)
  const result = spawnSync(launcher, args, { stdio: 'inherit', shell: useShell })
  return result.status ?? 1
}

function fail(message) {
  console.error(`\n  ${message}\n`)
  process.exit(1)
}

// Only `desktop` is app-owned and refuses to be created from the CLI. Other
// profiles are created on first use, so a missing directory is not an error for
// them - pnpm and the loader set the profile up themselves.
if (profile === 'desktop' && !existsSync(join(dshHome, 'profiles', profile))) {
  fail(
    `No "desktop" profile at ${join(dshHome, 'profiles', profile)}.\n` +
      `  The desktop profile is created by the app: open DeepSeek Harness once,\n` +
      `  quit it fully, then re-run this script.\n` +
      `  (Or pass --profile web, which is created on first use.)`,
  )
}

const launcher = resolveLauncher()
if (launcher === undefined) {
  fail(
    'Could not find the dsh launcher. Run this from the DSH install, or add the\n' +
      '  CLI to PATH from the app, then try again.',
  )
}
console.log(`launcher: ${launcher}`)
console.log(`profile:  ${profile}\n`)

for (const spec of PACKAGES) {
  console.log(`installing ${spec} ...`)
  const status = run(launcher, ['plugin', '--profile', profile, 'add', spec])
  if (status !== 0) {
    fail(
      `Installing ${spec} failed.\n` +
        '  If the message mentions ERR_PNPM_EXOTIC_SUBDEP, install dsh-llm-direct\n' +
        '  as its own bundle first - that is what this script already does, so the\n' +
        '  preset was probably installed before the adapter.',
    )
  }
}

if (apiKey !== undefined) {
  const dir = dshHome
  const file = join(dir, '.credentials.yaml')
  mkdirSync(dir, { recursive: true })

  let text = ''
  let hadFile = false
  if (existsSync(file)) {
    hadFile = true
    text = readFileSync(file, 'utf8')
    copyFileSync(file, `${file}.bak-mergepreset-${Date.now()}`)
  }

  if (/MERGE_GATEWAY_API_KEY\s*:/.test(text)) {
    console.log('MERGE_GATEWAY_API_KEY already present; left unchanged.')
  } else if (text.trim() === '') {
    writeFileSync(
      file,
      '# DSH credential store\nversion: 1\nrefs:\n  MERGE_GATEWAY_API_KEY: "' + apiKey + '"\n',
      { mode: 0o600 },
    )
    console.log(`wrote ${file}`)
  } else if (/^refs:\s*$/m.test(text)) {
    // Existing refs block: append one entry at the same indentation.
    text = text.replace(/^(refs:[ \t]*\n)/m, `$1  MERGE_GATEWAY_API_KEY: "${apiKey}"\n`)
    writeFileSync(file, text, { mode: 0o600 })
    console.log(`merged MERGE_GATEWAY_API_KEY into ${file}`)
  } else {
    // A file with no refs: add the block at the end rather than rewrite it.
    const suffix = text.endsWith('\n') ? '' : '\n'
    writeFileSync(file, `${text}${suffix}refs:\n  MERGE_GATEWAY_API_KEY: "${apiKey}"\n`, {
      mode: 0o600,
    })
    console.log(`added a refs block to ${file}`)
  }

  if (hadFile) console.log('  (previous file backed up beside it)')
}

console.log(`
Done. DeepSeek V4.1 Flash and GLM-5.3 Flash are now available for profile "${profile}".

The API key is resolved per request, so a change takes effect on the next call
without a restart. Restart DSH if you installed the bundles for the first time,
since plugin code loads once at startup.
`)
