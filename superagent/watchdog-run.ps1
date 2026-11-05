param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference='Stop'
$watchdogEntry=Join-Path $PSScriptRoot 'watchdog-host.mjs'
while(Test-Path -LiteralPath $ConfigPath){
  try{
    $watchdogConfig=Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if($watchdogConfig.proxy){$env:HTTP_PROXY=$watchdogConfig.proxy;$env:HTTPS_PROXY=$watchdogConfig.proxy;$env:ALL_PROXY=$watchdogConfig.proxy}
    & $watchdogConfig.node --use-env-proxy $watchdogEntry $ConfigPath
  }catch{}
  Start-Sleep -Seconds 5
}
