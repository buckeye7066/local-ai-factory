# RestartPolicy.ps1 - should the launcher supervisor restart the backend?
# ASCII only (PS 5.1 reads no-BOM files as CP1252).
#
# The supervisor exists so a transient crash does not take the deck down. It
# must NOT respawn a child that dies instantly for a permanent reason - that is
# the "flashing black window" failure class: a console that appears, the child
# dies in well under a second, and the loop immediately opens another one.
#
# Three rules, in order:
#   1. A CLEAN exit (0) is the user closing the deck. Never restart.
#   2. A FATAL exit (78 = EX_CONFIG; see src/server/exitCodes.ts) is a
#      permanent, operator-fixable condition - a refused LAN bind, a port held
#      by a foreign service. Restarting cannot fix it, so stop on the FIRST one
#      and print the reason.
#   3. A child that dies FASTER than $FastFailSeconds did not get as far as
#      serving anything - a crash at import, a missing dependency, a stale
#      flag. Two of those in a row is a respawn loop, not a flaky crash: stop.
# Otherwise restart, up to $MaxAttempts, with bounded EXPONENTIAL backoff so a
# slow-burn failure cannot spin the console.

Set-StrictMode -Version Latest

# Permanent, operator-fixable failure. Must match FATAL_EXIT_CODE in
# src/server/exitCodes.ts.
$script:FactoryFatalExitCode = 78

<#
.SYNOPSIS
Decide whether the supervisor restarts the backend after one exit.

.OUTPUTS
PSCustomObject with:
  Restart    [bool]   - launch again?
  DelayMs    [int]    - wait this long first (0 when not restarting)
  Reason     [string] - human-readable, printed by the launcher
  Fatal      [bool]   - stop because the failure is permanent
#>
function Get-RestartDecision {
    [CmdletBinding()]
    param(
        # Exit code the backend returned.
        [Parameter(Mandatory)][int]$ExitCode,
        # 1-based attempt that just finished.
        [Parameter(Mandatory)][int]$Attempt,
        # Hard cap on launches.
        [Parameter(Mandatory)][int]$MaxAttempts,
        # How long that attempt stayed alive.
        [Parameter(Mandatory)][double]$RanForSeconds,
        # Consecutive attempts (including this one) that died faster than
        # $FastFailSeconds.
        [int]$ConsecutiveFastFailures = 0,
        # Below this, the child never really started.
        [double]$FastFailSeconds = 5,
        # First backoff step; doubles each attempt up to $MaxDelayMs.
        [int]$BaseDelayMs = 2000,
        [int]$MaxDelayMs = 30000
    )

    function New-Decision($restart, $delay, $reason, $fatal) {
        [PSCustomObject]@{
            Restart = [bool]$restart
            DelayMs = [int]$delay
            Reason  = [string]$reason
            Fatal   = [bool]$fatal
        }
    }

    # 1. Clean shutdown - the user closed the deck.
    if ($ExitCode -eq 0) {
        return New-Decision $false 0 "Factory Deck exited normally." $false
    }

    # 2. Permanent failure - a restart provably cannot help.
    if ($ExitCode -eq $script:FactoryFatalExitCode) {
        return New-Decision $false 0 (
            "FATAL (exit $ExitCode): the backend reported a permanent, " +
            "operator-fixable problem - see the message above. Not restarting, " +
            "because a restart cannot fix it."
        ) $true
    }

    # 3. Instant death twice running is a respawn loop, not a flaky crash.
    if ($RanForSeconds -lt $FastFailSeconds -and $ConsecutiveFastFailures -ge 2) {
        return New-Decision $false 0 (
            "FATAL: the backend died in under $FastFailSeconds s on " +
            "$ConsecutiveFastFailures consecutive attempts (exit $ExitCode). " +
            "That is a startup crash - a missing dependency, a bad build, or a " +
            "stale flag - not a transient fault. Not restarting; fix the error " +
            "above and relaunch."
        ) $true
    }

    # Budget exhausted.
    if ($Attempt -ge $MaxAttempts) {
        return New-Decision $false 0 (
            "Gave up after $MaxAttempts attempts (last exit $ExitCode)."
        ) $false
    }

    # Transient - retry with bounded exponential backoff.
    $delay = [Math]::Min($BaseDelayMs * [Math]::Pow(2, $Attempt - 1), $MaxDelayMs)
    return New-Decision $true ([int]$delay) (
        "The backend exited with code $ExitCode; restarting in " +
        "$([int]($delay / 1000))s (attempt $($Attempt + 1)/$MaxAttempts)."
    ) $false
}
