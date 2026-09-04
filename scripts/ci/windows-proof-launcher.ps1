param(
  [Parameter(Mandatory = $true)]
  [string]$Request
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Quote-CmdToken([string]$Token) {
  if ($Token -notmatch '^[A-Za-z0-9 ._:@/\\=-]+$') {
    throw "Restricted proof command contains an unsafe cmd.exe token."
  }
  if ($Token.Contains(" ")) { return '"' + $Token + '"' }
  return $Token
}

try {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request))
  $requestData = $json | ConvertFrom-Json -Depth 8
  if ($requestData.user -notmatch '^[A-Za-z_][A-Za-z0-9_.-]{0,63}$') {
    throw "Restricted proof user is invalid."
  }
  if (-not [IO.Path]::IsPathFullyQualified([string]$requestData.workingDirectory)) {
    throw "Restricted proof working directory must be absolute."
  }
  if (-not (Test-Path -LiteralPath $requestData.workingDirectory -PathType Container)) {
    throw "Restricted proof working directory does not exist."
  }
  if (-not [IO.Path]::IsPathFullyQualified([string]$requestData.executable)) {
    throw "Restricted proof executable must be absolute."
  }
  if (-not (Test-Path -LiteralPath $requestData.executable -PathType Leaf)) {
    throw "Restricted proof executable does not exist."
  }
  $password = $env:FACTORY_PLATFORM_PROOF_WINDOWS_PASSWORD
  if ([string]::IsNullOrWhiteSpace($password)) {
    throw "Restricted proof account password is missing."
  }
  Remove-Item Env:FACTORY_PLATFORM_PROOF_WINDOWS_PASSWORD -ErrorAction SilentlyContinue

  $arguments = @($requestData.arguments)
  if ($arguments.Count -gt 128) {
    throw "Restricted proof command has too many arguments."
  }
  $psi = [Diagnostics.ProcessStartInfo]::new()
  $extension = [IO.Path]::GetExtension([string]$requestData.executable)
  if ($extension -match '^\.(cmd|bat)$') {
    $comspec = [Environment]::GetEnvironmentVariable("ComSpec", "Machine")
    if ([string]::IsNullOrWhiteSpace($comspec)) {
      $comspec = Join-Path $env:SystemRoot "System32\cmd.exe"
    }
    $tokens = @([string]$requestData.executable) + $arguments
    $line = '"' + (($tokens | ForEach-Object { Quote-CmdToken ([string]$_) }) -join " ") + '"'
    $psi.FileName = $comspec
    $psi.ArgumentList.Add("/d")
    $psi.ArgumentList.Add("/s")
    $psi.ArgumentList.Add("/c")
    $psi.ArgumentList.Add($line)
  } else {
    $psi.FileName = [string]$requestData.executable
    foreach ($argument in $arguments) {
      $psi.ArgumentList.Add([string]$argument)
    }
  }
  $psi.WorkingDirectory = [string]$requestData.workingDirectory
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.LoadUserProfile = $false
  $psi.UserName = [string]$requestData.user
  $psi.Domain = $env:COMPUTERNAME
  $psi.Password = ConvertTo-SecureString $password -AsPlainText -Force
  $psi.Environment.Clear()
  foreach ($property in $requestData.environment.PSObject.Properties) {
    if ($property.Name -notmatch '^[A-Za-z_][A-Za-z0-9_()]*$') {
      throw "Restricted proof environment contains an invalid name."
    }
    $psi.Environment[$property.Name] = [string]$property.Value
  }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $psi
  if (-not $process.Start()) { throw "Restricted proof process did not start." }
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  [Console]::Out.Write($stdout.GetAwaiter().GetResult())
  [Console]::Error.Write($stderr.GetAwaiter().GetResult())
  exit $process.ExitCode
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
