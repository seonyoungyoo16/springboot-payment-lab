param([Parameter(ValueFromRemainingArguments=$true)][string[]]$MavenArgs)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.mvn-runtime'
$mavenCommand = Join-Path $runtimeRoot 'apache-maven-3.9.9\bin\mvn.cmd'
if (-not (Test-Path -LiteralPath $mavenCommand)) {
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    $archivePath = Join-Path $runtimeRoot 'maven.zip'
    Invoke-WebRequest -Uri 'https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.zip' -OutFile $archivePath
    Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeRoot -Force
    Remove-Item -LiteralPath $archivePath
}
Push-Location $projectRoot
try { & $mavenCommand @MavenArgs; exit $LASTEXITCODE } finally { Pop-Location }
