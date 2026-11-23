#requires -Version 5.1
param(
    [string]$Config = (Join-Path $PSScriptRoot 'publish.local.json'),
    [switch]$Check,
    [switch]$Resume
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program exited with code $LASTEXITCODE." }
}

if (!(Test-Path -LiteralPath $Config -PathType Leaf)) { throw 'Missing deploy/publish.local.json. See deploy/publish.example.json.' }
$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
if ($settings.host -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]*$' -or $settings.user -notmatch '^[a-z_][a-z0-9_-]*$' -or
    $settings.repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid publishing configuration.' }
$identityFile = [string]$settings.identityFile
if ($identityFile.StartsWith('~/')) { $identityFile = Join-Path $HOME $identityFile.Substring(2) }
if (!(Test-Path -LiteralPath $identityFile -PathType Leaf)) { throw 'The deployment key file is missing.' }
$identityFile = (Resolve-Path -LiteralPath $identityFile).Path
$sshArguments = @('-F','NUL','-T','-i',$identityFile,'-o','BatchMode=yes','-o','IdentitiesOnly=yes',
    '-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',("$($settings.user)@$($settings.host)"))

Push-Location $repo
$releaseLock = $null
$workspace = $null
try {
    $branch = Invoke-Checked git @('branch','--show-current')
    if ($branch -ne 'main' -or (Invoke-Checked git @('status','--porcelain'))) {
        throw 'Publish from a clean main branch. Commit the changes you want to release first.'
    }
    $remote = Invoke-Checked git @('remote','get-url','--push','origin')
    if ($remote -ne "https://github.com/$($settings.repository).git" -and $remote -ne "git@github.com:$($settings.repository).git") {
        throw 'The origin push URL does not match the configured GitHub repository.'
    }
    Invoke-Checked ssh.exe ($sshArguments + @('status'))
    $buildRoot = Join-Path $repo 'analysis/netplay'
    New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
    $releaseLock = [IO.File]::Open((Join-Path $buildRoot 'release.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $commit = Invoke-Checked git @('rev-parse','HEAD')
    Invoke-Checked git @('push','origin','main')
    $published = Invoke-Checked git @('ls-remote','--heads','origin','refs/heads/main')
    if (($published -split '\s+')[0] -ne $commit) { throw 'GitHub main does not match this build.' }

    $archive = Join-Path $buildRoot "pending-$commit.tar.gz"
    if ($Resume) {
        if (!(Test-Path -LiteralPath $archive -PathType Leaf)) { throw 'There is no pending release for this commit.' }
    } else {
        $workspace = Join-Path $buildRoot ('publish-' + [guid]::NewGuid().ToString('N'))
        $package = Join-Path $workspace 'package'
        New-Item -ItemType Directory -Path $package -Force | Out-Null
        $sourceArchive = Join-Path $workspace 'source.tar'
        Invoke-Checked git @('archive','--format=tar','-o',$sourceArchive,$commit,'server','site')
        Invoke-Checked tar.exe @('-xf',$sourceArchive,'-C',$package)
        Push-Location (Join-Path $package 'server')
        try {
            Invoke-Checked npm.cmd @('ci','--omit=dev','--ignore-scripts','--bin-links=false','--no-audit','--no-fund')
            Invoke-Checked npm.cmd @('test')
        } finally { Pop-Location }

        $authority = Join-Path $package 'authority'
        $client = Join-Path $package 'client'
        & (Join-Path $repo 'run-netplay-build.ps1') -Mode linux -OutputDirectory $authority -Wait
        & (Join-Path $repo 'run-netplay-build.ps1') -Mode client -OutputDirectory $client -Wait
        $native = Get-Content -LiteralPath (Join-Path $authority 'build-report.json') -Raw | ConvertFrom-Json
        $web = Get-Content -LiteralPath (Join-Path $client 'client-build.json') -Raw | ConvertFrom-Json
        if ($native.kind -ne 'authority' -or $native.result -ne 'Succeeded' -or $web.kind -ne 'client' -or
            $native.contentHash -notmatch '^[a-f0-9]{64}$' -or $native.contentHash -ne $web.contentHash) {
            throw 'The Linux build and WebGL build do not match.'
        }
        if ((Invoke-Checked git @('rev-parse','HEAD')) -ne $commit -or (Invoke-Checked git @('status','--porcelain'))) {
            throw 'Tracked source changed during the build.'
        }
        $manifest = [ordered]@{version=1; commit=$commit; contentHash=$native.contentHash} | ConvertTo-Json -Compress
        [IO.File]::WriteAllText((Join-Path $package 'release.json'), $manifest, [Text.UTF8Encoding]::new($false))
        $builtArchive = Join-Path $workspace 'release.tar.gz'
        Invoke-Checked tar.exe @('-czf',$builtArchive,'-C',$package,'release.json','authority','client','server')
        Move-Item -LiteralPath $builtArchive -Destination $archive -Force
    }
    $digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    $action = if ($Check) { 'check' } else { 'publish' }
    Write-Host "Uploading $($commit.Substring(0, 12)) to $($settings.host)."
    try {
        Invoke-Checked node (@((Join-Path $PSScriptRoot 'upload-release.mjs'),$archive) + $sshArguments + @("$action $digest"))
    } catch {
        Write-Host 'Release package retained. Run with -Resume to retry for this commit.'
        throw
    }
    if (!$Check) { Remove-Item -LiteralPath $archive }
} finally {
    if ($workspace -and (Test-Path -LiteralPath $workspace)) {
        $resolved = (Resolve-Path -LiteralPath $workspace).Path
        $parent = (Resolve-Path -LiteralPath (Join-Path $repo 'analysis/netplay')).Path + [IO.Path]::DirectorySeparatorChar
        if ($resolved.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
    if ($releaseLock) { $releaseLock.Dispose() }
    Pop-Location
}
