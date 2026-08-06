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
        Start-Process $backendUrl
        exit 0
    }
    Write-Host "Port $backendPort is in use by another (non-Factory Deck) service." -ForegroundColor Red
    Write-Host "Free the port or change PORT, then re-run. Not opening it." -ForegroundColor Red
    exit 1
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
    & pnpm exec vite build
    if ($LASTEXITCODE -ne 0) {
        if (Test-Path $distIndex) {
            Write-Host "Build FAILED - starting with the previous UI build." -ForegroundColor Red
        } else {
            # No usable UI at all: fall back to the old two-process dev mode.
            Write-Host "Build FAILED and no previous build exists - falling back to dev mode." -ForegroundColor Red
            # Vite (:5180) proxies /api to the backend, so /api/health carries the
            # factory-deck marker here too. Open the dev UI ONLY when that marker
            # is present - a foreign 200 on :5180 (non-JSON or marker-less) is
            # never opened. Same check as the production preflight + poller.
            Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", `
                "for (`$i = 0; `$i -lt 240; `$i++) { try { `$r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://localhost:5180/api/health'; if ((`$r.Content | ConvertFrom-Json).service -eq 'factory-deck') { Start-Process 'http://localhost:5180'; break } } catch { }; Start-Sleep -Milliseconds 250 }"
            & pnpm dev
            exit $LASTEXITCODE
        }
    }
}

# --- 2. Open the browser as soon as the backend is actually ready. ---------
# Open ONLY after /api/health returns a body that parses as JSON AND carries the
# service:"factory-deck" marker - so a foreign service answering the port (incl.
# a 200 with a non-JSON body) is never opened. Same marker check as the preflight.
Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", `
    "for (`$i = 0; `$i -lt 240; `$i++) { try { `$r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '$backendUrl/api/health'; if ((`$r.Content | ConvertFrom-Json).service -eq 'factory-deck') { Start-Process '$backendUrl'; break } } catch { }; Start-Sleep -Milliseconds 250 }"

Write-Host ""
Write-Host "Starting Factory Deck (local AI software factory)..."
Write-Host "App: $backendUrl  (single process; browser opens when ready)"
Write-Host "(Close this window to stop the factory.)"
Write-Host ""

# --- 3. Run the backend in the foreground. ----------------------------------
# Invoke node directly: `pnpm server` as a child process exits silently with
# code 0 on this machine (known trap) - the direct binary is also faster.
& node --import tsx src/server/index.ts
