# Factory Deck launcher (ASCII only - PS 5.1 reads no-BOM files as CP1252).
# Single-process production mode: the backend on 127.0.0.1:5179 serves the
# built UI from dist/ui, so no Vite dev server or concurrently is needed.
# The UI is rebuilt only when a source file is newer than the build, and the
# browser opens when /api/health actually answers instead of a blind timer.
$ErrorActionPreference = "Stop"
Set-Location -Path (Split-Path -Parent $PSScriptRoot)  # repo root

$backendHost = "127.0.0.1"
$backendPort = 5179
$backendUrl = "http://${backendHost}:${backendPort}"
$startPath = if ($env:FACTORY_START_PATH) { $env:FACTORY_START_PATH.TrimStart("/") } else { "" }
$launchUrl = if ($startPath) { "$backendUrl/$startPath" } else { $backendUrl }
$devLaunchUrl = if ($startPath) { "http://localhost:5190/$startPath" } else { "http://localhost:5190" }
$distIndex = "dist\ui\index.html"

# True iff a TCP connection to the port can actually be ESTABLISHED (i.e. some
# process is listening) within the timeout. A refused OR timed-out connect both
# mean "no reachable listener". This is the authoritative "is the port occupied"
# signal because HTTP-level status is unreliable here (on this host a FREE port
# times out rather than refusing, so WebException.Status cannot classify it).
function Test-PortListening([string]$h, [int]$p, [int]$timeoutMs) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync($h, $p)
        return ($task.Wait($timeoutMs) -and $client.Connected)
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

# --- 0. Idempotency guard: if a Factory Deck is already answering, just open it.
# Prevents a second launch from spawning a duplicate backend or an orphaned
# browser-poll helper. We VERIFY the service marker so a foreign process holding
# the port is never mistaken for our app (and never opened). Classification:
#   * 2xx /api/health with the marker            -> OURS (open, exit 0)
#   * ANY other HTTP response (non-2xx or 2xx w/o marker) -> FOREIGN (exit 1)
#   * no HTTP response but a TCP listener EXISTS  -> FOREIGN/occupied (exit 1)
#       (covers a non-HTTP service, or one that accepts + holds without replying)
#   * no HTTP response AND no TCP listener        -> FREE (continue startup)
$portBusy = $false   # true if ANYTHING is on the port (HTTP reply OR raw listener)
$health = $null      # response body if we got a 2xx; $null otherwise
try {
    $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$backendUrl/api/health"
    $portBusy = $true
    $health = $resp.Content
} catch {
    if ($null -ne $_.Exception.Response) {
        # A non-2xx HTTP reply (404/500/401 THROW in Windows PowerShell) still
        # means something IS answering. Our own /api/health always returns 200
        # with the marker, so any HTTP-error response is a FOREIGN service.
        $portBusy = $true
    } else {
        # No HTTP response at all (timeout / receive failure / connection closed /
        # actively refused). Only a port with NO reachable TCP listener is FREE;
        # a listener that accepted the socket but didn't answer as us is FOREIGN.
        $portBusy = Test-PortListening $backendHost $backendPort 1500
    }
}
if ($portBusy) {
    # Treat the port as ours ONLY if a 200 body parses as JSON with the marker.
    $marker = $null
    if ($health) { try { $marker = ($health | ConvertFrom-Json).service } catch { $marker = $null } }
    if ($marker -eq "factory-deck") {
        Write-Host "Factory Deck is already running at $backendUrl - opening it." -ForegroundColor Green
        Start-Process $launchUrl
        exit 0
    }
    Write-Host "Port $backendPort is in use by another (non-Factory Deck) service." -ForegroundColor Red
    Write-Host "Free the port or change PORT, then re-run. Not opening it." -ForegroundColor Red
    exit 1
}

# --- Bootstrap. The running-service guard above must happen before any source
# or dependency mutation, so a second click only opens the existing revision.
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $node) {
    throw "Factory Deck needs Node.js 20 or newer, but node.exe is not available on PATH."
}
$nodeMajor = [int]((& node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 20) {
    throw "Factory Deck needs Node.js 20 or newer; this computer has $(& node --version)."
}

$packageManager = [string]((Get-Content "package.json" -Raw | ConvertFrom-Json).packageManager)
if ($packageManager -notmatch "^pnpm@(.+)$") {
    throw "Factory Deck requires package.json to declare a pinned pnpm version."
}
$pinnedPnpmVersion = $Matches[1]
$script:PnpmMode = $null
$script:PnpmExe = $null
$pnpm = Get-Command pnpm -CommandType Application -ErrorAction SilentlyContinue
if ($null -ne $pnpm) {
    $pnpmVersion = ([string](& $pnpm.Source --version 2>$null)).Trim()
    if ($LASTEXITCODE -eq 0 -and $pnpmVersion -eq $pinnedPnpmVersion) {
        $script:PnpmMode = "direct"
        $script:PnpmExe = $pnpm.Source
    }
}
if ($null -eq $script:PnpmMode) {
    $corepack = Get-Command corepack -CommandType Application -ErrorAction SilentlyContinue
    if ($null -ne $corepack) {
        # Do not create Corepack shims beside a system-wide Node installation;
        # a normal user may not own that directory. Invoke the project pin directly.
        $script:PnpmMode = "corepack"
        $script:PnpmExe = $corepack.Source
    }
}
if ($null -eq $script:PnpmMode) {
    throw "Factory Deck needs pnpm $pinnedPnpmVersion or Corepack on PATH."
}
function Invoke-Pnpm {
    if ($script:PnpmMode -eq "direct") {
        & $script:PnpmExe @args
    } else {
        & $script:PnpmExe pnpm @args
    }
}

# Fast-forward only a clean main checkout. The update is non-interactive and
# bounded, so an unreachable origin can never prevent the installed app opening.
$git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue
if ($null -ne $git -and (Test-Path ".git")) {
    $branch = ([string](& git branch --show-current 2>$null)).Trim()
    $trackedChanges = @(& git status --porcelain --untracked-files=no 2>$null)
    if ($branch -eq "main" -and $trackedChanges.Count -eq 0) {
        Write-Host "Checking for Factory Deck updates..." -ForegroundColor DarkGray
        $beforeHead = (& git rev-parse HEAD 2>$null).Trim()
        $previousPrompt = $env:GIT_TERMINAL_PROMPT
        try {
            $env:GIT_TERMINAL_PROMPT = "0"
            # Fetch is bounded separately because it cannot partially change
            # the worktree. Only after it finishes do we perform the local
            # fast-forward, which must never be killed mid-checkout.
            $update = Start-Process -FilePath $git.Source -ArgumentList @(
                "fetch", "--quiet", "origin", "main"
            ) -NoNewWindow -PassThru
            if (-not $update.WaitForExit(15000)) {
                & taskkill.exe /PID $update.Id /T /F 2>$null | Out-Null
                Write-Host "Update check timed out; continuing with the installed revision." -ForegroundColor Yellow
            } elseif ($update.ExitCode -ne 0) {
                Write-Host "Update check could not complete; continuing with the installed revision." -ForegroundColor Yellow
            } else {
                & git merge --ff-only --quiet FETCH_HEAD
                if ($LASTEXITCODE -ne 0) {
                    throw "Factory Deck fetched an update but could not apply a safe fast-forward."
                }
                $afterHead = (& git rev-parse HEAD 2>$null).Trim()
                if ($afterHead -and $afterHead -ne $beforeHead -and $env:FACTORY_LAUNCHER_REEXEC -ne "1") {
                    Write-Host "Factory Deck updated - restarting through the updated launcher." -ForegroundColor Green
                    $env:FACTORY_LAUNCHER_REEXEC = "1"
                    & powershell -NoLogo -NoProfile -File $PSCommandPath
                    exit $LASTEXITCODE
                }
            }
        } finally {
            $env:GIT_TERMINAL_PROMPT = $previousPrompt
        }
    } elseif ($trackedChanges.Count -gt 0) {
        Write-Host "Local source changes detected; automatic update skipped without overwriting them." -ForegroundColor Yellow
    }
}

# Repair missing or stale dependencies. pnpm's module manifest is the durable
# installation marker and must be at least as new as both dependency manifests.
$moduleMarker = "node_modules\.modules.yaml"
$needInstall = -not (Test-Path $moduleMarker)
if (-not $needInstall) {
    $installedAt = (Get-Item $moduleMarker).LastWriteTimeUtc
    foreach ($manifest in @("package.json", "pnpm-lock.yaml")) {
        if ((Get-Item $manifest).LastWriteTimeUtc -gt $installedAt) {
            $needInstall = $true
            break
        }
    }
}
if (-not $needInstall) {
    foreach ($requiredPackage in @(
        "node_modules\tsx\package.json",
        "node_modules\vite\package.json",
        "node_modules\.bin\vite.cmd"
    )) {
        if (-not (Test-Path $requiredPackage)) {
            $needInstall = $true
            break
        }
    }
}
if ($needInstall) {
    Write-Host "Factory Deck dependencies are missing or stale - repairing them..." -ForegroundColor Yellow
    Invoke-Pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
        throw "Factory Deck dependency repair failed (pnpm exit $LASTEXITCODE)."
    }
}

# --- 1. Rebuild the UI only when it is missing or stale. -------------------
$needBuild = -not (Test-Path $distIndex)
if (-not $needBuild) {
    $built = (Get-Item $distIndex).LastWriteTime
    $inputs = @(Get-ChildItem src -Recurse -File)
    foreach ($extra in @("index.html", "vite.config.ts", "package.json", "tailwind.config.js")) {
        if (Test-Path $extra) { $inputs += Get-Item $extra }
    }
    $newest = ($inputs | Measure-Object -Property LastWriteTime -Maximum).Maximum
    if ($newest -gt $built) { $needBuild = $true }
}
if ($needBuild) {
    Write-Host "UI build missing or stale - rebuilding (vite build)..." -ForegroundColor Yellow
    Invoke-Pnpm exec vite build
    if ($LASTEXITCODE -ne 0) {
        if (Test-Path $distIndex) {
            Write-Host "Build FAILED - starting with the previous UI build." -ForegroundColor Red
        } else {
            # No usable UI at all: fall back to the old two-process dev mode.
            Write-Host "Build FAILED and no previous build exists - falling back to dev mode." -ForegroundColor Red
            # Vite (:5190) proxies /api to the backend, so /api/health carries the
            # factory-deck marker here too. Open the dev UI ONLY when that marker
            # is present - a foreign 200 on :5190 (non-JSON or marker-less) is
            # never opened. Same check as the production preflight + poller.
            Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", `
                "for (`$i = 0; `$i -lt 240; `$i++) { try { `$r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://localhost:5190/api/health'; if ((`$r.Content | ConvertFrom-Json).service -eq 'factory-deck') { Start-Process '$devLaunchUrl'; break } } catch { }; Start-Sleep -Milliseconds 250 }"
            Invoke-Pnpm dev
            exit $LASTEXITCODE
        }
    }
}

# --- 2. Open the browser as soon as the backend is actually ready. ---------
# Open ONLY after /api/health returns a body that parses as JSON AND carries the
# service:"factory-deck" marker - so a foreign service answering the port (incl.
# a 200 with a non-JSON body) is never opened. Same marker check as the preflight.
Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", `
    "for (`$i = 0; `$i -lt 240; `$i++) { try { `$r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '$backendUrl/api/health'; if ((`$r.Content | ConvertFrom-Json).service -eq 'factory-deck') { Start-Process '$launchUrl'; break } } catch { }; Start-Sleep -Milliseconds 250 }"

Write-Host ""
Write-Host "Starting Factory Deck (local AI software factory)..."
Write-Host "App: $launchUrl  (single process; browser opens when ready)"
Write-Host "(Close this window to stop the factory.)"
Write-Host ""

# --- 2b. FREE route preflight. ----------------------------------------------
# Factory Deck runs FREE-PRIMARY: every model call goes through the local FCC
# proxy (the same free route the "Claude Code - FREE (Ollama)" shortcut turns
# on) at zero cost. Paid keys are a rescue tier only.
#
# Bring the proxy up here rather than letting the first model call discover it
# is dead: a dead free backend is precisely the condition that spends money, so
# it is worth 90 seconds up front to avoid it.
$freeBase = if ($env:FACTORY_FREE_BASE_URL) { $env:FACTORY_FREE_BASE_URL } else { "http://127.0.0.1:8082" }

function Test-FreeRouteUp([string]$base) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "$base/health"
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

if (Test-FreeRouteUp $freeBase) {
    Write-Host "FREE route: fcc-server is up at $freeBase - all model calls are free." -ForegroundColor Green
} else {
    Write-Host "FREE route: proxy not answering at $freeBase - starting fcc-server ..." -ForegroundColor Yellow
    $fcc = Get-Command fcc-server -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $fcc) {
        Write-Host "  fcc-server is not on PATH. The deck will start, but until the free" -ForegroundColor Red
        Write-Host "  route is up, calls can fall through to the PAID rescue tier." -ForegroundColor Red
        Write-Host "  Run the 'Claude Code - FREE (Ollama)' shortcut to bring it up." -ForegroundColor Red
    } else {
        $fccHome = if ($env:FCC_HOME) { $env:FCC_HOME } else { Join-Path $HOME ".fcc" }
        $fccLogs = Join-Path $fccHome "logs"
        if (-not (Test-Path $fccLogs)) { New-Item -ItemType Directory -Path $fccLogs -Force | Out-Null }
        $uri = [Uri]$freeBase
        # Messaging startup blocks the FastAPI bind (documented FCC trap).
        $prevMsg = $env:MESSAGING_PLATFORM; $prevHost = $env:HOST; $prevPort = $env:PORT
        try {
            if ($env:FCC_ENABLE_MESSAGING -ne "1") { $env:MESSAGING_PLATFORM = "none" }
            $env:HOST = $uri.Host
            $env:PORT = "$($uri.Port)"
            Start-Process -FilePath $fcc.Source -WorkingDirectory $fccHome `
                -RedirectStandardOutput (Join-Path $fccLogs "server.stdout.log") `
                -RedirectStandardError  (Join-Path $fccLogs "server.stderr.log") `
                -WindowStyle Hidden | Out-Null
        } finally {
            $env:MESSAGING_PLATFORM = $prevMsg; $env:HOST = $prevHost; $env:PORT = $prevPort
        }
        $deadline = (Get-Date).AddSeconds(90)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 1000
            if (Test-FreeRouteUp $freeBase) { break }
        }
        if (Test-FreeRouteUp $freeBase) {
            Write-Host "  FREE route is up at $freeBase." -ForegroundColor Green
        } else {
            Write-Host "  fcc-server did not answer within 90s. Starting anyway - the deck" -ForegroundColor Red
            Write-Host "  keeps retrying free and only pays if the route is PROVEN wedged." -ForegroundColor Red
        }
    }
}
Write-Host ""

# --- 3. Run the backend under a supervisor. ---------------------------------
# Invoke node directly: `pnpm server` as a child process exits silently with
# code 0 on this machine (known trap) - the direct binary is also faster.
#
# The supervisor restarts the backend if it dies unexpectedly - but ONLY when a
# restart could actually help. The decision lives in Get-RestartDecision
# (scripts/lib/RestartPolicy.ps1) so it is unit-testable without launching the
# app; see src/server/__tests__/launcherRestartPolicy.test.ts.
#
# It refuses to respawn in three cases, which together prevent a console window
# that reappears the instant it dies:
#   * exit 0            - the user closed the deck
#   * exit 78 (FATAL)   - permanent, operator-fixable (refused LAN bind, port
#                         held by a foreign service); a retry cannot fix it
#   * two instant deaths - a startup crash (missing dep / bad build / stale
#                         flag), not a transient fault
# Transient crashes retry with bounded EXPONENTIAL backoff (2s, 4s, 8s ... 30s).
. (Join-Path $PSScriptRoot "lib\RestartPolicy.ps1")

$maxAttempts = 5
$fastFailSeconds = 5
$consecutiveFastFailures = 0
$code = 0
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    $startedAt = Get-Date
    & node --import tsx src/server/index.ts
    $code = $LASTEXITCODE
    $ranFor = ((Get-Date) - $startedAt).TotalSeconds

    if ($ranFor -lt $fastFailSeconds) { $consecutiveFastFailures++ }
    else { $consecutiveFastFailures = 0 }

    $decision = Get-RestartDecision -ExitCode $code -Attempt $attempt `
        -MaxAttempts $maxAttempts -RanForSeconds $ranFor `
        -ConsecutiveFastFailures $consecutiveFastFailures `
        -FastFailSeconds $fastFailSeconds

    if (-not $decision.Restart) {
        if ($code -ne 0) {
            $colour = if ($decision.Fatal) { "Red" } else { "Yellow" }
            Write-Host ""
            Write-Host $decision.Reason -ForegroundColor $colour
        }
        break
    }

    Write-Host ""
    Write-Host $decision.Reason -ForegroundColor Yellow
    Start-Sleep -Milliseconds $decision.DelayMs
}
exit $code
