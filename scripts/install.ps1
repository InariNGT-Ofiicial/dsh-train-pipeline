param(
  [string]$Root = "",
  [switch]$Install,
  [switch]$DryRun
)
# ASCII-only for Windows PowerShell 5.1.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node 18+ is required." }
if (-not $Root) { $Root = $env:DSH_COVER_ROOT }
Write-Host "dsh-train-pipeline setup: $repo"
if ($DryRun) {
  Write-Host "[dry-run] node test/live.mjs train_doctor"
  if ($Install) { Write-Host "[dry-run] dsh plugin --profile desktop add $repo" }
  exit 0
}
$previousRoot = $env:DSH_COVER_ROOT
try {
  if ($Root) { $env:DSH_COVER_ROOT = $Root }
  & node (Join-Path $repo 'test/live.mjs') train_doctor
  if ($LASTEXITCODE -ne 0) { throw "Environment check failed. Configure train.local.json before installing." }
  if ($Install) {
    if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) { throw "dsh is not available in PATH." }
    & dsh plugin --profile desktop add $repo
    if ($LASTEXITCODE -ne 0) { throw "DSH plugin installation failed." }
    Write-Host "Installed. Reload DSH to load the plugin."
  } else {
    Write-Host "Next: dsh plugin --profile desktop add $repo"
  }
} finally { $env:DSH_COVER_ROOT = $previousRoot }
