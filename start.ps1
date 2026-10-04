param([int]$Port = 8795, [string]$BindAddress = '127.0.0.1')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
$bundledPnpm = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
if ($pnpmCommand) { $pnpm = $pnpmCommand.Source }
elseif (Test-Path -LiteralPath $bundledPnpm) { $pnpm = $bundledPnpm }
else { throw 'Install Node.js 22 or newer and pnpm 11, then run this script again.' }
$wrangler = Join-Path $PSScriptRoot 'node_modules\.bin\wrangler.cmd'
if (-not (Test-Path -LiteralPath $wrangler)) {
    & $pnpm install
    if ($LASTEXITCODE -ne 0) { throw 'Could not install Pages dependencies.' }
}
& $wrangler pages dev web --ip $BindAddress --port $Port
