param([switch]$SkipBuild)
$ErrorActionPreference='Stop'
$paymentRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $paymentRoot
if(Get-NetTCPConnection -State Listen -LocalPort 8480 -ErrorAction SilentlyContinue){throw 'Payment lab is already running. Stop the owned gateway before rebuilding.'}
if(-not(Test-Path -LiteralPath node_modules)){& npm ci;if($LASTEXITCODE -ne 0){throw 'npm ci failed'}}
& (Join-Path $PSScriptRoot 'setup-local.ps1')
if(-not $SkipBuild){& (Join-Path $PSScriptRoot 'maven.ps1') -q -f backend/pom.xml package;if($LASTEXITCODE -ne 0){throw 'Backend build failed'};& npm run build;if($LASTEXITCODE -ne 0){throw 'Frontend build failed'}}
& node scripts/gateway.mjs
