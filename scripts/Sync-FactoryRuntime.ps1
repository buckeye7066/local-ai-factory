# Factory Deck runtime synchronizer (ASCII-only for Windows PowerShell 5.1).
#
# Purpose: the editable checkout may contain legitimate tracked changes. The old
# launcher protected those changes by skipping updates entirely, which also let
# the desktop app run stale code indefinitely. This bootstrap keeps that safety
# boundary but runs the app from a clean origin/main worktree whenever the
# checkout is not safe to fast-forward in place.
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $git -or -not (Test-Path (Join-Path $repoRoot ".git"))) {
    # Non-git installs keep the existing launcher behavior.
    & powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "start-factory.ps1")
    exit $LASTEXITCODE
}

function Invoke-GitChecked {
    param(
        [Parameter(Mandatory=$true)][string]$WorkingDirectory,
        [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments
    )
    & $git.Source -C $WorkingDirectory @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed in $WorkingDirectory (exit $LASTEXITCODE)."
    }
}

# Fetching does not mutate either worktree, so it is safe even when the editable
# checkout is dirty. Do this before deciding which worktree will run the app.
$previousPrompt = $env:GIT_TERMINAL_PROMPT
try {
    $env:GIT_TERMINAL_PROMPT = "0"
    Write-Host "Checking Factory Deck origin/main..." -ForegroundColor DarkGray
    Invoke-GitChecked $repoRoot fetch --quiet origin main
} finally {
    $env:GIT_TERMINAL_PROMPT = $previousPrompt
}

$branch = ([string](& $git.Source -C $repoRoot branch --show-current 2>$null)).Trim()
$trackedChanges = @(& $git.Source -C $repoRoot status --porcelain --untracked-files=no 2>$null)
$launcherRoot = $repoRoot

if ($branch -eq "main" -and $trackedChanges.Count -eq 0) {
    $before = ([string](& $git.Source -C $repoRoot rev-parse HEAD 2>$null)).Trim()
    Invoke-GitChecked $repoRoot merge --ff-only --quiet origin/main
    $after = ([string](& $git.Source -C $repoRoot rev-parse HEAD 2>$null)).Trim()
    if ($before -ne $after) {
        Write-Host "Factory Deck updated to $($after.Substring(0,8))." -ForegroundColor Green
    } else {
        Write-Host "Factory Deck is current at $($after.Substring(0,8))." -ForegroundColor DarkGray
    }
} else {
    # Never overwrite or stash the editable checkout. A dedicated runtime
    # worktree is disposable by definition, so it can be hard-reset to
    # origin/main every launch while the owner's edits remain untouched.
    $runtimeParent = Join-Path $env:LOCALAPPDATA "Axiom\FactoryDeck"
    $runtimeRoot = Join-Path $runtimeParent "runtime"
    New-Item -ItemType Directory -Path $runtimeParent -Force | Out-Null

    if (Test-Path $runtimeRoot) {
        $runtimeGit = Join-Path $runtimeRoot ".git"
        if (-not (Test-Path $runtimeGit)) {
            throw "Factory Deck runtime path exists but is not a git worktree: $runtimeRoot"
        }
        Invoke-GitChecked $runtimeRoot reset --hard --quiet origin/main
        Invoke-GitChecked $runtimeRoot clean -fd --quiet
    } else {
        Invoke-GitChecked $repoRoot worktree add --force --detach $runtimeRoot origin/main
    }

    # Keep the existing local configuration and run history while executing the
    # current code revision. Secrets remain local on this machine.
    $sourceEnv = Join-Path $repoRoot ".env"
    if (Test-Path $sourceEnv) {
        Copy-Item -LiteralPath $sourceEnv -Destination (Join-Path $runtimeRoot ".env") -Force
    }
    $env:FACTORY_DATA_DIR = Join-Path $repoRoot ".factory"
    $env:WORKSPACE_ROOT = Join-Path $repoRoot "workspaces"
    $launcherRoot = $runtimeRoot
    $runtimeHead = ([string](& $git.Source -C $runtimeRoot rev-parse HEAD 2>$null)).Trim()
    Write-Host "Local source edits preserved; running clean Factory Deck $($runtimeHead.Substring(0,8)) from $runtimeRoot." -ForegroundColor Yellow
}

$launcher = Join-Path $launcherRoot "scripts\start-factory.ps1"
if (-not (Test-Path $launcher)) {
    throw "Factory Deck launcher is missing from the selected runtime: $launcher"
}

& powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $launcher
exit $LASTEXITCODE
