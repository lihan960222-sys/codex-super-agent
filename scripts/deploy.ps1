param([Parameter(Mandatory=$true)][string]$Runtime,[string]$Git='git')
$ErrorActionPreference='Stop'
$Runtime=[IO.Path]::GetFullPath($Runtime)
$repo=Split-Path $PSScriptRoot
$commit=& $Git -c safe.directory=$repo -C $repo rev-parse HEAD
if($LASTEXITCODE -ne 0){throw 'Cannot identify source commit'}
$dirty=& $Git -c safe.directory=$repo -C $repo status --porcelain
if($LASTEXITCODE -ne 0 -or $dirty){throw 'Deploy only a clean committed source tree'}
$releasePath=Join-Path $Runtime 'superagent-release.json'
$previous=Get-Content -LiteralPath $releasePath -Raw -Encoding UTF8|ConvertFrom-Json
$healthPath=Join-Path $Runtime 'superagent-health.json'
$health=Get-Content -LiteralPath $healthPath -Raw -Encoding UTF8|ConvertFrom-Json
if(-not $health.running -or ([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse($health.at)).TotalSeconds -gt 30 -or $health.pendingEffects -gt 0 -or $health.pendingReplies -gt 0){throw 'Deployment requires a fresh idle heartbeat and drained effects'}
if(@($health.leases).Count -ne 0 -or @($health.tasks | Where-Object { $_.status -in @('running','preparing','queued','uncertain') }).Count -ne 0){throw 'Deployment requires idle execution; do not interrupt active work'}
$settingsPath=Join-Path $Runtime 'superagent-settings.json'
$settingsHash=(Get-FileHash -LiteralPath $settingsPath).Hash
$main=Get-ScheduledTask -TaskName 'Codex Telegram Bridge'
$watch=Get-ScheduledTask -TaskName 'Codex Telegram Watchdog'
$configPath=Join-Path $Runtime 'config.json'
$config=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8|ConvertFrom-Json
$runPath=Join-Path $Runtime 'run.ps1'
$oldRun=[IO.File]::ReadAllText($runPath)
$oldRelative='releases\'+$previous.releaseId+'\superagent\bridge.mjs'
if(-not $oldRun.Contains($oldRelative)){throw 'Unexpected launcher entry'}
$id='codex-super-agent-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+$commit.Substring(0,8)
$newRoot=Join-Path (Join-Path $Runtime 'releases') $id
$backup=Join-Path (Join-Path $Runtime 'backups') $id
New-Item -ItemType Directory -Path $newRoot,$backup|Out-Null
foreach($area in @('superagent','telegram-bridge')){
 $target=Join-Path $newRoot $area
 New-Item -ItemType Directory -Path $target|Out-Null
 $files=& $Git -c safe.directory=$repo -C $repo ls-files -- $area
 if($LASTEXITCODE -ne 0){throw 'Cannot list tracked source files'}
 foreach($relative in $files){
  if($relative -match '\.test\.mjs$' -or $relative -match '/probe[^/]*\.mjs$'){continue}
  $source=Join-Path $repo $relative
  $destination=Join-Path $newRoot $relative
  New-Item -ItemType Directory -Force -Path (Split-Path $destination)|Out-Null
  Copy-Item -LiteralPath $source -Destination $destination
  if($relative.EndsWith('.mjs')){& $config.node --check $destination;if($LASTEXITCODE -ne 0){throw 'Release syntax invalid'}}
 }
}
$manifest=@(Get-ChildItem -LiteralPath $newRoot -Recurse -File|ForEach-Object{[pscustomobject]@{path=$_.FullName.Substring($newRoot.Length+1);sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}})
$manifest|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $newRoot 'manifest.json') -Encoding UTF8
$watchScript=Join-Path $newRoot 'superagent\watchdog-run.ps1'
$watchAction=New-ScheduledTaskAction -Execute $watch.Actions.Execute -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$watchScript+'" -ConfigPath "'+$configPath+'"') -WorkingDirectory $Runtime
# Prove task-management access before stopping either service or changing the launcher.
Set-ScheduledTask -TaskName $watch.TaskName -Action $watchAction -ErrorAction Stop|Out-Null
if((Get-ScheduledTask -TaskName $watch.TaskName -ErrorAction Stop).Actions.Arguments -cne $watchAction.Arguments){throw 'Watchdog action was not updated; abort before cutover'}
$watchStopped=$false;$mainStopped=$false;$changed=$false
try{
 Stop-ScheduledTask -TaskName $watch.TaskName -ErrorAction Stop
 $watchStopped=$true
 Stop-ScheduledTask -TaskName $main.TaskName -ErrorAction Stop
 $mainStopped=$true
 $watchHealth=Get-Content -LiteralPath (Join-Path $Runtime 'watchdog-status.json') -Raw -Encoding UTF8|ConvertFrom-Json
 foreach($processId in @($health.processId,$watchHealth.processId)){
  for($i=0;$i -lt 20 -and (Get-Process -Id $processId -ErrorAction SilentlyContinue);$i++){Start-Sleep -Seconds 1}
  if(Get-Process -Id $processId -ErrorAction SilentlyContinue){throw 'Existing process still alive; will not start a second consumer'}
 }
 $latest=Get-Content -LiteralPath $healthPath -Raw -Encoding UTF8|ConvertFrom-Json
 if($latest.pendingEffects -gt 0 -or $latest.pendingReplies -gt 0){throw 'New pending effects during deployment'}
 if(@($latest.leases).Count -ne 0 -or @($latest.tasks | Where-Object { $_.status -in @('running','preparing','queued','uncertain') }).Count -ne 0){throw 'Execution state changed during deployment'}
 if((Get-FileHash -LiteralPath $settingsPath).Hash -ne $settingsHash){throw 'Settings changed during deployment; retry with latest settings'}
 foreach($name in @('run.ps1','superagent-release.json','superagent-settings.json','superagent-health.json')){Copy-Item -LiteralPath (Join-Path $Runtime $name) -Destination $backup}
 foreach($name in @('state.sqlite','state.sqlite-wal','state.sqlite-shm')){$file=Join-Path $Runtime ('superagent-state\'+$name);if(Test-Path -LiteralPath $file){Copy-Item -LiteralPath $file -Destination $backup}}
 Export-ScheduledTask -TaskName $main.TaskName|Set-Content -LiteralPath (Join-Path $backup 'bridge-task.xml')
 $watch|Export-Clixml -LiteralPath (Join-Path $backup 'watch-task-before.xml')
 $newRun=$oldRun.Replace($oldRelative,('releases\'+$id+'\superagent\bridge.mjs'))
 [IO.File]::WriteAllText($runPath,$newRun,[Text.UTF8Encoding]::new($false))
 $changed=$true
 $release=[ordered]@{releaseId=$id;releaseRoot=$newRoot;backup=$backup;previousRelease=$previous.releaseId;sourceCommit=$commit;sourceRepository='https://github.com/lihan960222-sys/codex-super-agent';entry=(Join-Path $newRoot 'superagent\bridge.mjs');watchdogTask=$watch.TaskName;deployedAt=[DateTimeOffset]::UtcNow.ToString('o');preservedSettingsHash=$settingsHash}
 [IO.File]::WriteAllText($releasePath,($release|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
 Start-ScheduledTask -TaskName $main.TaskName -ErrorAction Stop
 Start-ScheduledTask -TaskName $watch.TaskName -ErrorAction Stop
 $release|ConvertTo-Json
}catch{
 if(-not $changed){Set-ScheduledTask -TaskName $watch.TaskName -Action $watch.Actions|Out-Null;if($mainStopped){Start-ScheduledTask -TaskName $main.TaskName};if($watchStopped){Start-ScheduledTask -TaskName $watch.TaskName}}
 # After cutover keep the current SQLite ledger and release; never restore an old Telegram offset.
 throw
}
