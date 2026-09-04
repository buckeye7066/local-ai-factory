param(
  [Parameter(Mandatory = $true)]
  [string]$WorkspaceRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$proofUser = "factoryproof"
$proofRoot = Join-Path $env:SystemDrive "factory-proof-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
$sandboxRoot = Join-Path $proofRoot "workspaces"
$stateRoot = Join-Path $proofRoot "state"
$password = [Guid]::NewGuid().ToString("N") + "aA1!"
Write-Output "::add-mask::$password"

function Invoke-Icacls([string[]]$Arguments, [string]$Failure) {
  & icacls.exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw $Failure }
}

try {
  if (Get-LocalUser -Name $proofUser -ErrorAction SilentlyContinue) {
    throw "Restricted proof account already exists unexpectedly."
  }

  $secure = ConvertTo-SecureString $password -AsPlainText -Force
  New-LocalUser -Name $proofUser -Password $secure -AccountNeverExpires -PasswordNeverExpires | Out-Null

  @($sandboxRoot, $stateRoot) | ForEach-Object {
    New-Item -ItemType Directory -Force -Path $_ | Out-Null
  }
  @(
    "home", "tmp", "appdata", "localappdata", "cache", "config", "data",
    "corepack", "pnpm", "npm", "yarn", "pip", "playwright"
  ) | ForEach-Object {
    New-Item -ItemType Directory -Force -Path (Join-Path $stateRoot $_) | Out-Null
  }

  Invoke-Icacls @($proofRoot, "/grant:r", "${proofUser}:(RX)", "/Q") `
    "Could not grant proof-root traversal."
  foreach ($writableRoot in @($sandboxRoot, $stateRoot)) {
    Invoke-Icacls @($writableRoot, "/grant:r", "${proofUser}:(OI)(CI)M", "/T", "/Q") `
      "Could not grant the proof account its isolated writable root."
  }
  if (-not [string]::IsNullOrWhiteSpace($env:PNPM_HOME)) {
    Invoke-Icacls @($env:PNPM_HOME, "/grant:r", "${proofUser}:(OI)(CI)RX", "/T", "/Q") `
      "Could not grant read-only access to the trusted pnpm runtime."
  }

  $writeDeny = "${proofUser}:(OI)(CI)(WD,AD,WEA,WA,DE,DC,WDAC,WO)"
  foreach ($trustedRoot in @($env:GITHUB_WORKSPACE, $env:RUNNER_TEMP)) {
    if (-not [string]::IsNullOrWhiteSpace($trustedRoot)) {
      Invoke-Icacls @($trustedRoot, "/deny", $writeDeny, "/T", "/Q") `
        "Could not protect trusted runner state from the proof account."
    }
  }
  if (Test-Path -LiteralPath ".factory") {
    Invoke-Icacls @(".factory", "/deny", "${proofUser}:(OI)(CI)F", "/T", "/Q") `
      "Could not isolate Factory proof state."
  }
  Get-ChildItem -LiteralPath . -Filter "*-workspaces.tar" -File -ErrorAction SilentlyContinue |
    ForEach-Object {
      Invoke-Icacls @($_.FullName, "/deny", "${proofUser}:F", "/Q") `
        "Could not isolate the immutable transport archive."
    }

  $env:WORKSPACE_ROOT = $WorkspaceRoot
  $env:FACTORY_PLATFORM_SANDBOX_ROOT = $sandboxRoot
  $env:FACTORY_PLATFORM_PROOF_USER = $proofUser
  $env:FACTORY_PLATFORM_PROOF_STATE_ROOT = $stateRoot
  $env:FACTORY_PLATFORM_PROOF_WINDOWS_LAUNCHER = Join-Path $env:GITHUB_WORKSPACE "scripts\ci\windows-proof-launcher.ps1"
  # Same-process protected channel. The ephemeral credential is never persisted or exported between steps.
  $env:FACTORY_PLATFORM_PROOF_WINDOWS_PASSWORD = $password
  $env:ALLOW_UNTRUSTED_SCRIPTS = "true"
  $env:CI = "true"

  & pnpm exec tsx src/cli/factory-platform-proof.ts record
  if ($LASTEXITCODE -ne 0) {
    throw "Restricted Windows platform proof failed with exit code $LASTEXITCODE."
  }
} finally {
  Remove-Item Env:FACTORY_PLATFORM_PROOF_WINDOWS_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:FACTORY_PLATFORM_PROOF_WINDOWS_LAUNCHER -ErrorAction SilentlyContinue
  Remove-Item Env:FACTORY_PLATFORM_PROOF_STATE_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:FACTORY_PLATFORM_PROOF_USER -ErrorAction SilentlyContinue
  Remove-Item Env:FACTORY_PLATFORM_SANDBOX_ROOT -ErrorAction SilentlyContinue

  if (Get-Command taskkill.exe -ErrorAction SilentlyContinue) {
    & taskkill.exe /F /FI "USERNAME eq $env:COMPUTERNAME\$proofUser" /IM "*" *> $null
  }
  if (Get-LocalUser -Name $proofUser -ErrorAction SilentlyContinue) {
    Remove-LocalUser -Name $proofUser -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $proofRoot -Recurse -Force -ErrorAction SilentlyContinue
}
