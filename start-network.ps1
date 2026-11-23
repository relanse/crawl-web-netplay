param([switch]$Public, [switch]$Stop, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$serverRoot = Join-Path $PSScriptRoot 'server'
$dataRoot = Join-Path $serverRoot 'online-data'
$statePath = Join-Path $dataRoot 'launcher.json'
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json }
$running = if ($state) { Get-Process -Id $state.pid -ErrorAction SilentlyContinue }
if ($running -and $running.StartTime.ToUniversalTime() -gt ([datetime]$state.started).ToUniversalTime()) { $running = $null }
if ($Stop) {
    if ($running) {
        [IO.File]::WriteAllText((Join-Path $dataRoot 'stop-request'), [string]$state.id)
        for ($i = 0; $i -lt 30 -and (Get-Process -Id $running.Id -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
        if (Get-Process -Id $running.Id -ErrorAction SilentlyContinue) { throw '服务尚未退出，请查看 online-data 中的日志。' }
    }
    return
}
if ($running -and ($Public -ne ([string]$state.origin).StartsWith('https:'))) { throw '另一种模式正在运行。请先双击“停止联机”，再启动需要的模式。' }
if (!$running) {
    $nodePath = Join-Path $PSScriptRoot 'tools/node.exe'
    if (!(Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node -ErrorAction Stop).Source }
    $argsForNode = @('launch-network.mjs')
    if ($Public) { $argsForNode += '--public' }
    $child = Start-Process -FilePath $nodePath -ArgumentList $argsForNode -WorkingDirectory $serverRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataRoot 'server.log') -RedirectStandardError (Join-Path $dataRoot 'server-errors.log') -PassThru
    $state = $null
    for ($i = 0; $i -lt 150; $i++) {
        if ($child.HasExited) { throw '启动失败，请查看 server/online-data/server-errors.log。' }
        if (Test-Path -LiteralPath $statePath) {
            $candidate = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
            if ($candidate.pid -eq $child.Id) { $state = $candidate; break }
        }
        Start-Sleep -Milliseconds 500
    }
    if (!$state) { throw '启动超时，请查看 server/online-data 中的日志。' }
}
if (!$NoBrowser) {
    $key = (Get-Content -LiteralPath (Join-Path $dataRoot 'access-key.txt') -Raw).Trim()
    Start-Process ([string]$state.origin + '/#' + [uri]::EscapeDataString($key))
}
Write-Output $state.origin
Write-Output (Join-Path $dataRoot '联机邀请.txt')
