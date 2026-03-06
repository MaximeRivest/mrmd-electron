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
    @{ Name = 'mrmd-jupyter-bridge'; Url = 'https://github.com/MaximeRivest/mrmd-jupyter-bridge.git' }
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
Assert-Command 'python' 'Install Python 3.11+ from https://www.python.org/downloads/windows/' | Out-Null
Assert-Command 'uv' 'Install uv from https://docs.astral.sh/uv/getting-started/installation/' | Out-Null
Assert-NodeVersion
Assert-PythonVersion
Assert-UvVersion

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

Write-Section 'Installing/building required packages'
Invoke-Checked $editorDir 'mrmd-editor: npm ci' @('npm', 'ci')
Invoke-Checked $editorDir 'mrmd-editor: npm run build' @('npm', 'run', 'build')
Invoke-Checked $syncDir 'mrmd-sync: npm ci' @('npm', 'ci')
Invoke-Checked $monitorDir 'mrmd-monitor: npm ci' @('npm', 'ci')
Invoke-Checked $electronDir 'mrmd-electron: npm ci' @('npm', 'ci')
Invoke-Checked $electronDir 'mrmd-electron: npm run bundle' @('npm', 'run', 'bundle')

if ($BuildDir) {
    Write-Section 'Building unpacked Windows app'
    Invoke-Checked $electronDir 'mrmd-electron: npm run build:dir' @('npm', 'run', 'build:dir')
}

if ($BuildWin) {
    Write-Section 'Building Windows installer + portable artifacts'
    Invoke-Checked $electronDir 'mrmd-electron: npm run build:win' @('npm', 'run', 'build:win')
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
