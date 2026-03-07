[CmdletBinding()]
param(
    [string]$RootDir,
    [switch]$PullExisting,
    [switch]$IncludeOptional,
    [switch]$BuildDir,
    [switch]$BuildWin
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
.SYNOPSIS
Bootstraps a Windows packaging/dev machine for MRMD.

.DESCRIPTION
Clones the sibling repos expected by mrmd-electron, installs the required
Node dependencies, builds mrmd-editor, bundles sibling CLIs for Electron, and
optionally produces Windows build artifacts.

Also performs Windows-specific preflight checks so local development stays
close to a distributable setup (Git line endings, long paths, packaging assets,
and expected build/config files).

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-windows.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-windows.ps1 -PullExisting -BuildDir

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-windows.ps1 -PullExisting -IncludeOptional -BuildWin
#>

function Write-Section([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Write-Success([string]$Message) {
    Write-Host "[ok] $Message" -ForegroundColor Green
}

function Write-Info([string]$Message) {
    Write-Host "[info] $Message" -ForegroundColor DarkCyan
}

function Write-WarnMsg([string]$Message) {
    Write-Host "[warn] $Message" -ForegroundColor Yellow
}

function Assert-Command([string]$Name, [string]$InstallHint) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "Missing required command '$Name'. $InstallHint"
    }
    return $cmd.Source
}

function Get-CommandOutput([scriptblock]$Script) {
    $output = & $Script 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ($output | Out-String)
    }
    return ($output | Out-String).Trim()
}

function Assert-NodeVersion {
    $raw = Get-CommandOutput { node --version }
    $version = $raw.Trim().TrimStart('v')
    $major = [int]($version.Split('.')[0])
    if ($major -lt 18) {
        throw "Node.js 18+ is required. Found: $raw"
    }
    Write-Success "Node.js $raw"
}

function Assert-PythonVersion {
    $raw = Get-CommandOutput { python --version }
    $match = [regex]::Match($raw, 'Python\s+(\d+)\.(\d+)\.(\d+)')
    if (-not $match.Success) {
        throw "Could not parse Python version from: $raw"
    }

    $major = [int]$match.Groups[1].Value
    $minor = [int]$match.Groups[2].Value
    if ($major -lt 3 -or ($major -eq 3 -and $minor -lt 11)) {
        throw "Python 3.11+ is required. Found: $raw"
    }
    Write-Success $raw
}

function Assert-UvVersion {
    $raw = Get-CommandOutput { uv --version }
    Write-Success "uv $raw"
}

function Invoke-Checked([string]$WorkingDirectory, [string]$Label, [string[]]$Command) {
    Write-Info "$Label"
    Push-Location $WorkingDirectory
    try {
        $exe = $Command[0]
        $args = @()
        if ($Command.Length -gt 1) {
            $args = $Command[1..($Command.Length - 1)]
        }

        & $exe @args
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed: $($Command -join ' ')"
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-NpmInstall([string]$WorkingDirectory, [string]$ProjectName) {
    try {
        Invoke-Checked $WorkingDirectory "${ProjectName}: npm ci" @('npm', 'ci')
    }
    catch {
        Write-WarnMsg "${ProjectName}: npm ci failed, falling back to npm install (likely lockfile drift)"
        Invoke-Checked $WorkingDirectory "${ProjectName}: npm install" @('npm', 'install')
    }
}

function Invoke-OptionalNodeSetup([string]$WorkingDirectory, [string]$ProjectName, [switch]$BuildIfPresent) {
    if (-not (Test-Path (Join-Path $WorkingDirectory 'package.json'))) {
        return
    }

    Invoke-NpmInstall $WorkingDirectory $ProjectName

    if ($BuildIfPresent) {
        $packageJson = Get-Content -Raw -Path (Join-Path $WorkingDirectory 'package.json') | ConvertFrom-Json
        if ($packageJson.scripts -and $packageJson.scripts.build) {
            Invoke-Checked $WorkingDirectory "${ProjectName}: npm run build" @('npm', 'run', 'build')
        }
    }
}

function Get-GitConfigValue([string]$Scope, [string]$Key) {
    try {
        $value = (& git config $Scope --get $Key 2>$null)
        if ($LASTEXITCODE -eq 0) {
            return ($value | Out-String).Trim()
        }
    }
    catch {
    }
    return $null
}

function Test-RegistryValue([string]$Path, [string]$Name, [object]$ExpectedValue) {
    try {
        $item = Get-ItemProperty -Path $Path -Name $Name -ErrorAction Stop
        return $item.$Name -eq $ExpectedValue
    }
    catch {
        return $false
    }
}

function Assert-PathExists([string]$Path, [string]$Description) {
    if (-not (Test-Path $Path)) {
        throw "Missing ${Description}: $Path"
    }
    Write-Success "$Description present: $Path"
}

function Show-WindowsReadinessHints {
    $autoCrlf = Get-GitConfigValue '--global' 'core.autocrlf'
    if ([string]::IsNullOrWhiteSpace($autoCrlf)) {
        Write-WarnMsg "Git core.autocrlf is not set globally. Recommended for this repo: git config --global core.autocrlf false"
    }
    elseif ($autoCrlf -ne 'false') {
        Write-WarnMsg "Git core.autocrlf=$autoCrlf. Recommended for Electron/Node cross-platform work: false"
    }
    else {
        Write-Success 'Git core.autocrlf=false'
    }

    $longPathsEnabled = Test-RegistryValue 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' 'LongPathsEnabled' 1
    $gitLongPaths = Get-GitConfigValue '--system' 'core.longpaths'
    if (-not $longPathsEnabled) {
        Write-WarnMsg 'Windows long paths are not enabled. Recommended: enable LongPathsEnabled=1 in Windows and reboot if npm ever hits path-length errors.'
    }
    else {
        Write-Success 'Windows long paths enabled'
    }

    if ([string]::IsNullOrWhiteSpace($gitLongPaths) -or $gitLongPaths -ne 'true') {
        Write-WarnMsg 'Git core.longpaths is not enabled system-wide. Recommended (admin shell): git config --system core.longpaths true'
    }
    else {
        Write-Success 'Git core.longpaths=true'
    }

    Write-Info 'Unsigned local Windows builds are fine for development. Add code signing later via CSC_LINK / CSC_KEY_PASSWORD for release signing.'
}

function Ensure-Repo([hashtable]$Repo) {
    $repoDir = Join-Path $RootDir $Repo.Name

    if (Test-Path $repoDir) {
        if (-not (Test-Path (Join-Path $repoDir '.git'))) {
            throw "Path exists but is not a git repo: $repoDir"
        }

        Write-Success "$($Repo.Name) already present"
        if ($PullExisting) {
            Invoke-Checked $repoDir "Updating $($Repo.Name)" @('git', 'pull', '--ff-only')
        }
    }
    else {
        Invoke-Checked $RootDir "Cloning $($Repo.Name)" @('git', 'clone', $Repo.Url, $repoDir)
    }

    return $repoDir
}

function Show-BuildArtifacts([string]$DistDir) {
    if (-not (Test-Path $DistDir)) {
        Write-WarnMsg "No dist directory found yet: $DistDir"
        return
    }

    $artifacts = Get-ChildItem -Path $DistDir -File -Recurse |
        Where-Object {
            $_.Extension -in @('.exe', '.msi', '.blockmap', '.yml') -or
            $_.Name -like '*win-unpacked*'
        } |
        Select-Object -ExpandProperty FullName

    if (-not $artifacts) {
        Write-Info "Build output directory: $DistDir"
        return
    }

    Write-Host ''
    Write-Host 'Artifacts:' -ForegroundColor Cyan
    foreach ($artifact in $artifacts) {
        Write-Host "  $artifact"
    }
}

$script:MandatoryRepos = @(
    @{ Name = 'mrmd-editor'; Url = 'https://github.com/MaximeRivest/mrmd-editor.git' },
    @{ Name = 'mrmd-electron'; Url = 'https://github.com/MaximeRivest/mrmd-electron.git' },
    @{ Name = 'mrmd-sync'; Url = 'https://github.com/MaximeRivest/mrmd-sync.git' },
    @{ Name = 'mrmd-monitor'; Url = 'https://github.com/MaximeRivest/mrmd-monitor.git' },
    @{ Name = 'mrmd-r'; Url = 'https://github.com/MaximeRivest/mrmd-r.git' },
    @{ Name = 'mrmd-julia'; Url = 'https://github.com/MaximeRivest/mrmd-julia.git' }
)

$script:OptionalRepos = @(
    @{ Name = 'mrmd-python'; Url = 'https://github.com/MaximeRivest/mrmd-python.git' },
    @{ Name = 'mrmd-ai'; Url = 'https://github.com/MaximeRivest/mrmd-ai.git' },
    @{ Name = 'mrmd-bash'; Url = 'https://github.com/MaximeRivest/mrmd-bash.git' },
    @{ Name = 'mrmd-js'; Url = 'https://github.com/MaximeRivest/mrmd-js.git' },
    @{ Name = 'mrmd-project'; Url = 'https://github.com/MaximeRivest/mrmd-project.git' },
    @{ Name = 'mrmd-jupyter-bridge'; Url = 'https://github.com/MaximeRivest/mrmd-jupyter-bridge.git' },
    @{ Name = 'mrmd-pty'; Url = 'https://github.com/MaximeRivest/mrmd-pty.git' }
)

if ($env:OS -ne 'Windows_NT') {
    throw 'This bootstrap script is intended to run on Windows.'
}

$electronDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electronDirName = Split-Path $electronDir -Leaf
if ($electronDirName -ne 'mrmd-electron') {
    throw "Expected script to live under a mrmd-electron checkout. Found: $electronDir"
}

if ([string]::IsNullOrWhiteSpace($RootDir)) {
    $RootDir = Split-Path $electronDir -Parent
}

$RootDir = [System.IO.Path]::GetFullPath($RootDir)
if (-not (Test-Path $RootDir)) {
    New-Item -ItemType Directory -Path $RootDir | Out-Null
}

Write-Section 'Checking required tools'
Assert-Command 'git' 'Install Git for Windows from https://git-scm.com/download/win' | Out-Null
Assert-Command 'node' 'Install Node.js 18+ from https://nodejs.org/' | Out-Null
Assert-Command 'npm' 'npm should come with Node.js. Reinstall Node.js if needed.' | Out-Null
Assert-Command 'python' 'Install Python 3.11+ from https://www.python.org/downloads/windows/ and make sure it is added to PATH.' | Out-Null
Assert-Command 'uv' 'Install uv from https://docs.astral.sh/uv/getting-started/installation/' | Out-Null
Assert-NodeVersion
Assert-PythonVersion
Assert-UvVersion

Write-Section 'Windows packaging readiness checks'
Show-WindowsReadinessHints
Assert-PathExists (Join-Path $electronDir 'electron-builder.config.cjs') 'electron-builder config'
Assert-PathExists (Join-Path $electronDir 'build\icon.ico') 'Windows app icon'
Assert-PathExists (Join-Path $electronDir 'scripts\bundle-siblings.js') 'sibling bundler script'

Write-Section "Using workspace root: $RootDir"

Write-Section 'Ensuring required repositories are present'
foreach ($repo in $MandatoryRepos) {
    if ($repo.Name -eq 'mrmd-electron') {
        Write-Success 'mrmd-electron already present (this checkout)'
        if ($PullExisting) {
            Invoke-Checked $electronDir 'Updating mrmd-electron' @('git', 'pull', '--ff-only')
        }
        continue
    }

    Ensure-Repo $repo | Out-Null
}

if ($IncludeOptional) {
    Write-Section 'Ensuring optional repositories are present'
    foreach ($repo in $OptionalRepos) {
        Ensure-Repo $repo | Out-Null
    }
}

$editorDir = Join-Path $RootDir 'mrmd-editor'
$syncDir = Join-Path $RootDir 'mrmd-sync'
$monitorDir = Join-Path $RootDir 'mrmd-monitor'
$mrmdJsDir = Join-Path $RootDir 'mrmd-js'
$mrmdProjectDir = Join-Path $RootDir 'mrmd-project'
$jupyterBridgeDir = Join-Path $RootDir 'mrmd-jupyter-bridge'
$distDir = Join-Path $electronDir 'dist'

if ($IncludeOptional) {
    Write-Section 'Installing optional Node sibling packages used via local links'
    Invoke-OptionalNodeSetup $mrmdProjectDir 'mrmd-project'
    Invoke-OptionalNodeSetup $jupyterBridgeDir 'mrmd-jupyter-bridge'
    Invoke-OptionalNodeSetup $mrmdJsDir 'mrmd-js' -BuildIfPresent
}

Write-Section 'Installing/building required packages'
Invoke-NpmInstall $editorDir 'mrmd-editor'
Invoke-Checked $editorDir 'mrmd-editor: npm run build' @('npm', 'run', 'build')
Invoke-NpmInstall $syncDir 'mrmd-sync'
Invoke-NpmInstall $monitorDir 'mrmd-monitor'
Invoke-NpmInstall $electronDir 'mrmd-electron'
Invoke-Checked $electronDir 'mrmd-electron: npm run bundle' @('npm', 'run', 'bundle')

if ($BuildDir) {
    Write-Section 'Building unpacked Windows app'
    Invoke-Checked $electronDir 'mrmd-electron: npm run build:dir' @('npm', 'run', 'build:dir')
    Show-BuildArtifacts $distDir
}

if ($BuildWin) {
    Write-Section 'Building Windows installer + portable artifacts'
    Invoke-Checked $electronDir 'mrmd-electron: npm run build:win' @('npm', 'run', 'build:win')
    Show-BuildArtifacts $distDir
}

Write-Section 'Done'
Write-Success 'Windows bootstrap completed.'
Write-Host ''
Write-Host 'Next useful commands:' -ForegroundColor Cyan
Write-Host "  cd $electronDir"
Write-Host '  npm start                # run app in dev mode'
Write-Host '  npm run build:dir        # fast packaged-app sanity check'
Write-Host '  npm run build:win        # NSIS installer + portable EXE'
Write-Host ''
Write-Host 'If you need to sync existing checkouts later, rerun with -PullExisting.' -ForegroundColor DarkCyan
Write-Host 'If you want local editable Python runtime repos too, rerun with -IncludeOptional.' -ForegroundColor DarkCyan
