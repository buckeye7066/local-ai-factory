# Factory Deck runtime synchronizer (ASCII-only for Windows PowerShell 5.1).
#
# Purpose: the editable checkout may contain legitimate tracked changes. The old
# launcher protected those changes by skipping updates entirely, which also let
# the desktop app run stale code indefinitely. This bootstrap keeps that safety
# boundary but runs the app from a clean origin/main worktree whenever the
# checkout is not safe to fast-forward in place.
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot

# Git for Windows commonly exposes BOTH cmd\git.exe and bin\git.exe on PATH.
# Windows PowerShell 5.1 can therefore return multiple ApplicationInfo objects
# for `Get-Command git`; reading `.Source` from that array coerces both paths
# into one invalid command string. Resolve exactly one executable once and use
# that scalar path for every git invocation in this bootstrap.
$git = Microsoft.PowerShell.Core\Get-Command git -CommandType Application -All -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($null -eq $git -or -not (Test-Path (Join-Path $repoRoot ".git"))) {
    # Non-git installs keep the existing launcher behavior, but still use the
    # single-application resolver below so duplicate npm/git shims cannot break
    # start-factory.ps1.
    $launcherRoot = $repoRoot
} else {
    $script:GitExe = [string]$git.Source
    if (-not $script:GitExe -or -not (Test-Path -LiteralPath $script:GitExe)) {
        throw "Factory Deck found git but could not resolve one executable path."
    }

    function Invoke-GitChecked {
        param(
            [Parameter(Mandatory=$true)][string]$WorkingDirectory,
            [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments
        )
        & $script:GitExe -C $WorkingDirectory @Arguments
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

    $branch = ([string](& $script:GitExe -C $repoRoot branch --show-current 2>$null)).Trim()
    $trackedChanges = @(& $script:GitExe -C $repoRoot status --porcelain --untracked-files=no 2>$null)
    $launcherRoot = $repoRoot

    if ($branch -eq "main" -and $trackedChanges.Count -eq 0) {
        $before = ([string](& $script:GitExe -C $repoRoot rev-parse HEAD 2>$null)).Trim()
        Invoke-GitChecked $repoRoot merge --ff-only --quiet origin/main
        $after = ([string](& $script:GitExe -C $repoRoot rev-parse HEAD 2>$null)).Trim()
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
        $runtimeHead = ([string](& $script:GitExe -C $runtimeRoot rev-parse HEAD 2>$null)).Trim()
        Write-Host "Local source edits preserved; running clean Factory Deck $($runtimeHead.Substring(0,8)) from $runtimeRoot." -ForegroundColor Yellow
    }
}

$launcher = Join-Path $launcherRoot "scripts\start-factory.ps1"
if (-not (Test-Path $launcher)) {
    throw "Factory Deck launcher is missing from the selected runtime: $launcher"
}

# Windows command-shim compatibility shield.
#
# `Get-Command pnpm -CommandType Application` can return BOTH pnpm.cmd and the
# extensionless pnpm shim. Git for Windows can likewise return cmd\git.exe and
# bin\git.exe. start-factory.ps1 historically assumed one ApplicationInfo and
# then read `.Source`; PowerShell joins an array of Source values into one bogus
# command path. Intercept only Application lookups and deterministically return
# the first real command. All other Get-Command behavior delegates unchanged to
# the built-in cmdlet. Because the launcher is dot-sourced below, this one guard
# covers node, pnpm, corepack, git, fcc-server, and future executable lookups.
function Get-Command {
    param(
        [Parameter(Position=0, Mandatory=$true)][string[]]$Name,
        [System.Management.Automation.CommandTypes]$CommandType,
        [System.Management.Automation.ActionPreference]$ErrorAction = [System.Management.Automation.ActionPreference]::Continue
    )

    $params = @{ Name = $Name; ErrorAction = $ErrorAction }
    if ($PSBoundParameters.ContainsKey("CommandType")) {
        $params["CommandType"] = $CommandType
    }
    $found = Microsoft.PowerShell.Core\Get-Command @params
    if ($PSBoundParameters.ContainsKey("CommandType") -and
        (($CommandType -band [System.Management.Automation.CommandTypes]::Application) -ne 0)) {
        return $found | Select-Object -First 1
    }
    return $found
}

# Dot-source the selected launcher so the compatibility shield remains in scope.
# start-factory.ps1 exits with the backend's exit code, so control normally does
# not return here; the explicit exit covers early-return variants safely.
. $launcher
exit $LASTEXITCODE
