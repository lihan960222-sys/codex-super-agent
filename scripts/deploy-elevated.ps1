param([Parameter(Mandatory=$true)][string]$Runtime,[Parameter(Mandatory=$true)][string]$ResultFile,[string]$Git='git')
$ErrorActionPreference='Stop'
try{
 $release=& (Join-Path $PSScriptRoot 'deploy.ps1') -Runtime $Runtime -Git $Git
 $result=@{success=$true;release=($release -join "`n");finishedAt=[DateTimeOffset]::UtcNow.ToString('o')}
}catch{
 $result=@{success=$false;error=$_.Exception.Message;position=$_.InvocationInfo.PositionMessage;finishedAt=[DateTimeOffset]::UtcNow.ToString('o')}
}
[IO.File]::WriteAllText($ResultFile,($result|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
