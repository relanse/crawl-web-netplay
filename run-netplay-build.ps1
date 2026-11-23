param(
    [ValidateSet('probe','storage','web-transport','visual-audit','server','client','linux')][string]$Mode = 'probe',
    [string]$OutputDirectory,
    [switch]$Wait
)
$ErrorActionPreference = 'Stop'
$netplayRoot = Join-Path $PSScriptRoot 'analysis/netplay'
New-Item -ItemType Directory -Path $netplayRoot -Force | Out-Null
$editor = 'C:/Program Files/Unity/Hub/Editor/2022.3.62f3c1/Editor/Unity.exe'
$project = Join-Path $PSScriptRoot 'web-project'
$lockPath = Join-Path $project 'Temp/UnityLockfile'
if (Test-Path -LiteralPath $lockPath) {
    try { $lockProbe = [System.IO.File]::Open($lockPath, 'Open', 'ReadWrite', 'None'); $lockProbe.Dispose() }
    catch { throw 'Unity project is already open; do not run a second writer.' }
}
$runName = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $netplayRoot ('unity-' + $Mode + '-' + $runName + '.log')
$env:CRAWL_TEST_OUTPUT = Join-Path $netplayRoot ('editor-tests/' + $runName)
$env:CRAWL_SERVER_OUTPUT = Join-Path $netplayRoot 'windows-probe'
$env:CRAWL_WEB_OUTPUT = Join-Path $netplayRoot 'web-transport-probe'
if ($Mode -eq 'server') { $env:CRAWL_SERVER_OUTPUT = Join-Path $netplayRoot 'authority-runtime' }
if ($Mode -eq 'linux') { $env:CRAWL_SERVER_OUTPUT = Join-Path $netplayRoot 'linux-authority' }
if ($Mode -eq 'client') { $env:CRAWL_WEB_OUTPUT = Join-Path $netplayRoot 'network-client' }
if ($OutputDirectory) {
    $destination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
    switch ($Mode) {
        'linux' { $env:CRAWL_SERVER_OUTPUT = $destination }
        'client' { $env:CRAWL_WEB_OUTPUT = $destination }
        default { throw '-OutputDirectory is supported for linux and client builds.' }
    }
}
$method = switch ($Mode) { 'linux' { 'CrawlServerBuild.BuildLinuxServer' } 'probe' { 'CrawlServerBuild.TestAndBuildWindowsProbe' } 'storage' { 'CrawlNetplayTests.RunStorage' } 'web-transport' { 'CrawlTransportProbeBuild.BuildWeb' } 'visual-audit' { 'CrawlVisualAudit.Run' } 'server' { 'CrawlServerBuild.BuildWindowsServer' } 'client' { 'CrawlClientBuild.Build' } }
$target = if ($Mode -in @('web-transport','client')) { 'WebGL' } elseif ($Mode -eq 'linux') { 'Linux64' } else { 'Win64' }
$arguments = '-batchmode -nographics -quit -accept-apiupdate -job-worker-count 2 -buildTarget {3} -projectPath "{0}" -executeMethod {1} -logFile "{2}"' -f $project,$method,$log,$target
$process = Start-Process -FilePath $editor -ArgumentList $arguments -WindowStyle Hidden -PassThru
@{pid=$process.Id;started=$process.StartTime.ToUniversalTime().ToString('o');log=$log;mode=$Mode;testOutput=$env:CRAWL_TEST_OUTPUT;buildOutput=$env:CRAWL_SERVER_OUTPUT} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $netplayRoot 'unity-build-process.json')
Write-Output ('Started Unity ' + $Mode + ' PID ' + $process.Id + '; log: ' + $log)
if ($Wait) {
    $process.WaitForExit()
    if ($process.ExitCode -ne 0 -or !(Select-String -LiteralPath $log -SimpleMatch 'Exiting batchmode successfully now!' -Quiet)) {
        throw "Unity $Mode build failed. See $log"
    }
}
