$ErrorActionPreference='Stop'
$paymentProject=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $paymentProject
$paymentRuntime=Join-Path $paymentProject '.runtime'
New-Item -ItemType Directory -Path $paymentRuntime -Force | Out-Null
function Get-PaymentArchive($Url,$File,$Hash){if(-not(Test-Path -LiteralPath $File)){Invoke-WebRequest -Uri $Url -OutFile $File};if((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -ne $Hash){throw "Archive checksum mismatch: $File"}}
if(-not(Test-Path -LiteralPath (Join-Path $paymentRuntime 'postgres/bin/postgres.exe'))){
 $archive=Join-Path $paymentRuntime 'postgres.jar';Get-PaymentArchive 'https://repo.maven.apache.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-windows-amd64/17.11.0/embedded-postgres-binaries-windows-amd64-17.11.0.jar' $archive '98040FAE18DD9633FF95932125B0CECF0A45A1A9312E216E2A33AD03A31D4251'
 New-Item -ItemType Directory -Path (Join-Path $paymentRuntime 'pg-archive'),(Join-Path $paymentRuntime 'postgres') -Force | Out-Null
 & tar -xf $archive -C (Join-Path $paymentRuntime 'pg-archive'); & tar -xf (Join-Path $paymentRuntime 'pg-archive/postgres-windows-x86_64.txz') -C (Join-Path $paymentRuntime 'postgres');if($LASTEXITCODE -ne 0){throw 'PostgreSQL extraction failed'}
 }
if(-not(Test-Path -LiteralPath (Join-Path $paymentRuntime 'redis/Redis-7.4.3-Windows-x64-cygwin/redis-server.exe'))){
 $archive=Join-Path $paymentRuntime 'redis.zip';Get-PaymentArchive 'https://github.com/redis-windows/redis-windows/releases/download/7.4.3/Redis-7.4.3-Windows-x64-cygwin.zip' $archive 'F6FE3DBBEA180672FE08CBA80759168EA68A51CD7EE4F097E1B8905A053D0AD1';Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $paymentRuntime 'redis') -Force
}
$paymentPgBin=Join-Path $paymentRuntime 'postgres/bin'
foreach($cluster in @(@('merchant',55452),@('psp',55454))){$data=Join-Path $paymentRuntime ('pg-'+$cluster[0]);if(-not(Test-Path -LiteralPath (Join-Path $data 'PG_VERSION'))){& (Join-Path $paymentPgBin 'initdb.exe') -D $data -U paylab -A trust --encoding=UTF8 --locale=C;if($LASTEXITCODE -ne 0){throw 'initdb failed'}};& (Join-Path $paymentPgBin 'pg_ctl.exe') -D $data status *> $null;if($LASTEXITCODE -ne 0){& (Join-Path $paymentPgBin 'pg_ctl.exe') -D $data -l (Join-Path $paymentRuntime ($cluster[0]+'.log')) -o ('-h 127.0.0.1 -p '+$cluster[1]) -w -t 20 start;if($LASTEXITCODE -ne 0){throw 'PostgreSQL startup failed'}}}
if(-not(Get-NetTCPConnection -State Listen -LocalPort 56489 -ErrorAction SilentlyContinue)){$data=Join-Path $paymentRuntime 'redis-data';New-Item -ItemType Directory -Path $data -Force | Out-Null;$unix='/cygdrive/'+$data.Substring(0,1).ToLowerInvariant()+$data.Substring(2).Replace('\','/');Start-Process -FilePath (Join-Path $paymentRuntime 'redis/Redis-7.4.3-Windows-x64-cygwin/redis-server.exe') -ArgumentList @('--bind','127.0.0.1','--port','56489','--dir',$unix,'--appendonly','yes','--loglevel','warning') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $paymentRuntime 'redis.log') -RedirectStandardError (Join-Path $paymentRuntime 'redis-error.log')}
if(-not(Test-Path -LiteralPath (Join-Path $paymentRuntime 'dev-key.pem'))){$openssl='C:\Program Files\Git\usr\bin\openssl.exe';if(-not(Test-Path -LiteralPath $openssl)){$openssl=(Get-Command openssl).Source};& $openssl req -x509 -newkey rsa:2048 -nodes -keyout (Join-Path $paymentRuntime 'dev-key.pem') -out (Join-Path $paymentRuntime 'dev-cert.pem') -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -days 30 *> $null;if($LASTEXITCODE -ne 0){throw 'Certificate generation failed'}}
& node scripts/init-infra.mjs
if($LASTEXITCODE -ne 0){throw 'Infrastructure initialization failed'}
Write-Output 'Owned merchant PostgreSQL:55452, PG PostgreSQL:55454, Redis:56489 ready'
