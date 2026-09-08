#requires -Version 5.1
[CmdletBinding()]
param([string]$SourcePath = '')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $SourcePath) { $SourcePath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'Repair-All-Axiom-App-Shortcuts.ps1' }
$SourcePath = (Resolve-Path -LiteralPath $SourcePath).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ('Axiom launcher test ' + [guid]::NewGuid().ToString('N'))
$originalLocalAppData = $env:LOCALAPPDATA
$script:assertions = 0
$script:lastStart = @{}
$script:realLaunch = $false
function Assert-Launcher([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:assertions++
}
# Match the real cmdlet's empty-ArgumentList rejection, and capture arguments.
function Start-Process {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$FilePath,
        [string]$WorkingDirectory,
        [ValidateNotNullOrEmpty()][string[]]$ArgumentList
    )
    $script:lastStart = @{}
    foreach ($key in $PSBoundParameters.Keys) { $script:lastStart[$key] = $PSBoundParameters[$key] }
    if ($script:realLaunch) {
        Microsoft.PowerShell.Management\Start-Process @PSBoundParameters -WindowStyle Hidden -Wait -RedirectStandardOutput (Join-Path $root 'stdout.txt') -RedirectStandardError (Join-Path $root 'stderr.txt')
    }
}
try {
    New-Item -ItemType Directory -Path $root | Out-Null
    $tokens = $null; $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$tokens, [ref]$parseErrors)
    Assert-Launcher (@($parseErrors).Count -eq 0) 'Installer must parse under Windows PowerShell 5.1.'
    # Load only the production launch functions, without running the installer.
    foreach ($name in @('Quote-ProcessArgument', 'Start-LocalTarget')) {
        $function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
        Assert-Launcher ($null -ne $function) "Missing production function: $name"
        . ([scriptblock]::Create($function.Extent.Text))
    }
    $exe = Join-Path $root 'Native executable with spaces.exe'
    Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\whoami.exe') -Destination $exe
    $script:realLaunch = $true
    Assert-Launcher (Start-LocalTarget -Path $exe) 'A native executable must launch with no arguments.'
    Assert-Launcher (-not $script:lastStart.ContainsKey('ArgumentList')) 'No-argument launch must OMIT ArgumentList.'
    Assert-Launcher (-not [string]::IsNullOrWhiteSpace((Get-Content (Join-Path $root 'stdout.txt') -Raw))) 'The real native process must have executed.'
    $script:realLaunch = $false
    Assert-Launcher (Start-LocalTarget -Path $exe -Arguments @()) 'Explicit empty argument arrays must work.'
    Assert-Launcher (-not $script:lastStart.ContainsKey('ArgumentList')) 'Explicit empty arguments must not bind ArgumentList.'
    Assert-Launcher (Start-LocalTarget -Path $exe -Arguments @('one', 'two words')) 'Non-empty arguments must work.'
    Assert-Launcher ($script:lastStart.ArgumentList.Count -eq 2) 'Argument count must be preserved.'
    Assert-Launcher ($script:lastStart.ArgumentList[1] -ceq '"two words"') 'Arguments containing spaces must stay quoted.'
    Assert-Launcher ($script:lastStart.FilePath -ceq $exe) 'Executable paths containing spaces must remain intact.'
    $script:lastStart = @{}
    Assert-Launcher (-not (Start-LocalTarget -Path (Join-Path $root 'missing.exe'))) 'Missing targets must return false.'
    Assert-Launcher ($script:lastStart.Count -eq 0) 'Missing targets must not start any process.'
    foreach ($extension in @('.ps1', '.vbs', '.bat', '.cmd')) {
        $scriptPath = Join-Path $root ('Script with spaces' + $extension)
        Set-Content -LiteralPath $scriptPath -Value ''
        Assert-Launcher (Start-LocalTarget -Path $scriptPath) "Script launch regressed: $extension"
        Assert-Launcher ($script:lastStart.ArgumentList -contains ('"' + $scriptPath + '"')) "Script path lost its quotes: $extension"
    }
    # Every install happens in a disposable LOCALAPPDATA and shortcut folder.
    # No real desktop shortcut, application, manuscript or user setting is changed.
    $env:LOCALAPPDATA = Join-Path $root 'Local App Data'
    $desktop = Join-Path $root 'Desktop with spaces'
    $desktop2 = Join-Path $root 'Another desktop folder'
    $launcherRoot = Join-Path $env:LOCALAPPDATA 'AxiomProgramLaunchers'
    foreach ($folder in @($launcherRoot, $desktop, $desktop2)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
    $installed = Join-Path $launcherRoot 'AxiomAppLauncher.ps1'
    $stale = '# Old installed launcher: must be backed up and replaced.'
    Set-Content -LiteralPath $installed -Value $stale
    $shell = New-Object -ComObject WScript.Shell
    $shortcutPath = Join-Path $desktop 'ForgePress.lnk'
    foreach ($folder in @($desktop, $desktop2)) {
        $shortcut = $shell.CreateShortcut((Join-Path $folder 'ForgePress.lnk'))
        $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\notepad.exe'
        $shortcut.Arguments = 'old-arguments'
        $shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',13'
        $shortcut.Save()
    }
    $oldShortcutHash = (Get-FileHash -LiteralPath $shortcutPath).Hash
    $oldIcon = $shell.CreateShortcut($shortcutPath).IconLocation
    $unrelated = Join-Path $desktop 'SermonSmith.lnk'
    $link = $shell.CreateShortcut($unrelated)
    $link.TargetPath = Join-Path $env:SystemRoot 'System32\notepad.exe'
    $link.Save()
    $unrelatedHash = (Get-FileHash -LiteralPath $unrelated).Hash
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        & $SourcePath -InstallOnly -OnlyApps ForgePress -ShortcutFolders @($desktop, $desktop2) | Out-Null
        Assert-Launcher ((Get-FileHash $installed).Hash -eq (Get-FileHash $SourcePath).Hash) "Reinstall $attempt must deploy exactly the corrected source."
        foreach ($folder in @($desktop, $desktop2)) {
            $check = $shell.CreateShortcut((Join-Path $folder 'ForgePress.lnk'))
            Assert-Launcher ($check.TargetPath -ieq (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')) 'Shortcut must use Windows PowerShell.'
            Assert-Launcher ($check.Arguments -match '^-WindowStyle Hidden ') 'Reinstallation must preserve hidden launcher startup.'
            Assert-Launcher ($check.Arguments.Contains('-File "' + $installed + '" -AppName "ForgePress"')) 'Shortcut must use the newly installed launcher.'
            Assert-Launcher ($check.WindowStyle -eq 7) 'Shortcut must retain minimized window style.'
            Assert-Launcher ($check.IconLocation -eq $oldIcon) 'Reinstallation must preserve the original app icon.'
        }
        Assert-Launcher ((Get-FileHash $unrelated).Hash -eq $unrelatedHash) 'Scoped installation must not touch other applications.'
        if ($attempt -eq 1) {
            $backups = @(Get-ChildItem $launcherRoot -Filter 'AxiomAppLauncher.ps1.backup-*')
            Assert-Launcher ($backups.Count -gt 0) 'An overwritten launcher must be backed up.'
            Assert-Launcher ((Get-Content $backups[0].FullName -Raw).Trim() -eq $stale) 'Launcher backup must contain the original bytes.'
            $linkBackups = @(Get-ChildItem $launcherRoot -Filter 'ForgePress.lnk.backup-*')
            Assert-Launcher ($linkBackups.Count -eq 2) 'Identical shortcut names in two folders must have separate backups.'
            Assert-Launcher (@($linkBackups | Where-Object { (Get-FileHash $_.FullName).Hash -eq $oldShortcutHash }).Count -gt 0) 'Original shortcut must be recoverable.'
            # Simulate an old installation replacing the runtime before reinstalling.
            Set-Content -LiteralPath $installed -Value '# Simulated old installer overwrite.'
        }
    }
    & $installed -InstallOnly -OnlyApps ForgePress -ShortcutFolders @($desktop) | Out-Null
    Assert-Launcher ((Get-FileHash $installed).Hash -eq (Get-FileHash $SourcePath).Hash) 'Reinstalling from the installed launcher must not corrupt itself.'
    Assert-Launcher ($shell.CreateShortcut($shortcutPath).Arguments -match '^-WindowStyle Hidden ') 'Self-reinstallation must keep the hidden ForgePress shortcut.'
    $beforeInvalid = (Get-FileHash $installed).Hash
    $rejected = $false
    try { & $SourcePath -InstallOnly -OnlyApps 'Not a registered application' -ShortcutFolders @($desktop) | Out-Null }
    catch { $rejected = $_.Exception.Message -like 'Unknown application selection:*' }
    Assert-Launcher $rejected 'Unknown application selections must fail clearly.'
    Assert-Launcher ((Get-FileHash $installed).Hash -eq $beforeInvalid) 'Invalid selection must not replace the installed launcher.'
    Write-Host "PASS: $script:assertions launcher assertions (native launch, arguments, reinstall twice, self-reinstall, backups and scoped shortcuts)."
} finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
