# dsh-merge — short, readable wrapper around the dsh CLI (Windows PowerShell).
#
#   .\dsh-merge.ps1            install into the desktop profile
#   .\dsh-merge.ps1 web        install into the web profile instead
#
# Finds the DSH launcher, installs this bundle, and prints one line per step.
param([string]$Profile = 'desktop')

$ErrorActionPreference = 'Stop'
$Spec = 'https://github.com/Unnidentified/dsh-merge-preset/archive/refs/tags/v0.3.3.tar.gz'

function Find-Dsh {
  $onPath = Get-Command dsh -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
    "$env:ProgramFiles\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return $null
}

$Dsh = Find-Dsh
if (-not $Dsh) {
  Write-Error "dsh: launcher not found. Add the CLI to PATH from DeepSeek Harness, or run with dsh on PATH."
  exit 1
}

Write-Host "profile: $Profile"
Write-Host "source:  $Spec"
Write-Host ""

& $Dsh plugin --profile $Profile add $Spec

Write-Host ""
Write-Host "Done. Quit and reopen DeepSeek Harness, then open Settings -> Merge Gateway."
