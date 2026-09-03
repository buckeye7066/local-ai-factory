#requires -Version 5.1
<#
Repair-All-Axiom-App-Shortcuts.ps1

Purpose
-------
Repair Axiom desktop shortcuts so application icons open the application itself,
not a GitHub repository page.

The script installs a durable launcher under:
  %LOCALAPPDATA%\AxiomProgramLaunchers\AxiomAppLauncher.ps1

It then rewrites recognized shortcuts on the Windows Desktop and in:
  G:\One Drive\Desktop\Apps

Design rules
------------
1. Never use a github.com web page as an application launch target.
2. Prefer the verified deployed-app URL for cloud apps.
3. Prefer the verified local launcher/executable for installed local apps.
4. If a local target is missing, use a managed checkout of the corresponding
   private GitHub repository and a repository-native launcher.
5. Preserve existing shortcut icons.
6. Back up every shortcut target/argument before changing it.
7. Verify every repaired shortcut after saving it.
#>

[CmdletBinding()]
param(
    [string]$AppName = '',
    [switch]$InstallOnly,
    [string[]]$ShortcutFolders = @(
        [Environment]::GetFolderPath('Desktop'),
        'G:\One Drive\Desktop\Apps'
    ),
    [string]$GitHubOwner = 'buckeye7066'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Normalize-Name {
    param([Parameter(Mandatory)][string]$Name)
    return ($Name.ToLowerInvariant() -replace '[^a-z0-9]', '')
}

function New-App {
    param(
        [Parameter(Mandatory)][string]$Name,
        [string[]]$Aliases = @(),
        [ValidateSet('local','web','repo')][string]$Mode = 'repo',
        [string]$Target = '',
        [string]$Url = '',
        [ValidateSet('edge','chrome','default')][string]$Browser = 'edge',
        [string]$Repo = '',
        [string]$Branch = 'main',
        [string[]]$Candidates = @(),
        [string[]]$ExtraArguments = @()
    )
    [pscustomobject]@{
        Name = $Name
        Aliases = @($Aliases)
        Mode = $Mode
        Target = $Target
        Url = $Url
        Browser = $Browser
        Repo = $Repo
        Branch = $Branch
        Candidates = @($Candidates)
        ExtraArguments = @($ExtraArguments)
    }
}

function Get-AppRegistry {
    $user = $env:USERPROFILE
    @(
        (New-App -Name 'PromoPilot' -Mode web -Url 'https://promopilot-production-6370.up.railway.app' -Browser chrome -Repo 'promopilot'),
        (New-App -Name 'Mind Over Math' -Mode web -Url 'https://mind-over-math-three.vercel.app' -Browser edge -Repo 'mind-over-math'),
        (New-App -Name 'SermonSmith' -Aliases @('SermonSmith AI by Axiom BioLabs') -Mode web -Url 'https://sermonsmith.vercel.app' -Browser edge -Repo 'sermonsmith'),
        (New-App -Name 'Repo Rewards' -Mode web -Url 'https://web-production-d7db7.up.railway.app' -Browser chrome -Repo 'repo-rewards'),
        (New-App -Name 'GeneMap Discovery' -Aliases @('GeneMap','Axiom GeneMap Discovery') -Mode web -Url 'https://genemap-discovery.vercel.app' -Browser edge -Repo 'genemap-discovery'),
        (New-App -Name 'Are We Mice Or Are We Men' -Aliases @('Are We Mice Or Are We Men?') -Mode web -Url 'https://are-we-mice-or-are-we-men.vercel.app' -Browser edge -Repo 'are-we-mice-or-are-we-men'),
        (New-App -Name 'FlexFactor' -Mode local -Target (Join-Path $user 'flexfactor\flexfactor_launch.ps1') -Repo 'flexfactor' -Candidates @('flexfactor_launch.ps1')),
        (New-App -Name 'Audit a Program' -Mode local -Target (Join-Path $user 'flexfactor\flexfactor_audit_launch.ps1') -Repo 'flexfactor' -Candidates @('flexfactor_audit_launch.ps1')),
        (New-App -Name 'Scout a Program' -Aliases @('FlexFactor Scout','Scout a Program (FlexFactor Scout)') -Mode local -Target (Join-Path $user 'flexfactor\flexfactor_scout_launch.ps1') -Repo 'flexfactor' -Candidates @('flexfactor_scout_launch.ps1')),
        (New-App -Name 'IPlay' -Aliases @('Iplay') -Mode local -Target (Join-Path $user 'avatar-video\iplay\iplay.pyw') -Repo 'Iplay' -Candidates @('Launch-IPlay.cmd','iplay.pyw')),
        (New-App -Name 'LiveHealth' -Aliases @('Live Health','base44-health') -Mode local -Target (Join-Path $user 'base44-health\scripts\launch-local.cmd') -Repo 'livehealth' -Candidates @('scripts\launch-local.cmd','launch-local.cmd','start.ps1')),
        (New-App -Name 'Incognito' -Mode local -Target (Join-Path $user 'incognito\launch.bat') -Repo 'incognito' -Candidates @('launch.bat','launch.cmd','start.ps1')),
        (New-App -Name 'Kidney Antigen Discovery' -Mode local -Target (Join-Path $user 'kidney-antigen-discovery\launch.bat') -Repo 'kidney-antigen-discovery' -Candidates @('launch.bat','launch.cmd','start.ps1')),
        (New-App -Name 'Factory Deck' -Aliases @('Local AI Factory') -Mode local -Target (Join-Path $user 'local-ai-factory\scripts\start-factory.cmd') -Repo 'local-ai-factory' -Candidates @('scripts\start-factory.cmd','scripts\start-factory.ps1')),
        (New-App -Name 'Purpose Foundry' -Mode local -Target (Join-Path $user 'local-ai-factory\scripts\start-purpose-foundry.cmd') -Repo 'local-ai-factory' -Candidates @('scripts\start-purpose-foundry.cmd')),
        (New-App -Name 'Ellie' -Mode local -Target (Join-Path $user 'Ellie\Start-Ellie.bat') -Repo 'Ellie' -Candidates @('Start-Ellie.bat','Launch-Ellie.bat','desktop\ellie.vbs')),
        (New-App -Name 'ForgePress' -Mode local -Target (Join-Path $user 'ForgePress\ForgePress.exe') -Repo 'ForgePress' -Candidates @('ForgePress.exe')),
        (New-App -Name 'Family Stewardship Navigator' -Aliases @('Family Stewardship') -Mode local -Target 'G:\family-stewardship-navigator\Start-Family-Stewardship.cmd' -Repo 'family-stewardship-navigator' -Candidates @('Start-Family-Stewardship.cmd','start.ps1')),
        (New-App -Name 'DirectShift Health' -Aliases @('DirectShift') -Mode local -Target (Join-Path $user 'directshift-health\start-directshift.cmd') -Repo 'directshift-health' -Candidates @('start-directshift.cmd','start.ps1')),
        (New-App -Name 'Clean Slate' -Mode local -Target (Join-Path $user 'CleanSlate\Run-CleanSlate.ps1') -Repo 'clean-slate' -Candidates @('Run-CleanSlate.ps1','run.ps1')),
        (New-App -Name 'App Store Publisher' -Mode local -Target (Join-Path $user 'app-store-publisher\launch.vbs') -Repo 'app-store-publisher' -Candidates @('launch.vbs')),
        (New-App -Name 'AI Time' -Aliases @('AITime','AI-Time') -Mode local -Target (Join-Path $user 'AITime\AI Time.vbs') -Repo 'ai-time' -Candidates @('AI Time.vbs','start-aitime.ps1')),
        (New-App -Name 'Free and Clean' -Aliases @('Free & Clean','Free-and-Clean') -Mode local -Target (Join-Path $user 'free-and-clean\system_cleaner\run_cleaner.ps1') -Repo 'free-and-clean' -Candidates @('system_cleaner\run_cleaner.ps1','Run-FreeAndClean.bat','run_free_and_clean.ps1')),
        (New-App -Name 'Family Castle Clash' -Aliases @('Family Clash') -Mode repo -Repo 'family-castle-clash' -Candidates @('launcher\FamilyCastleClash.vbs','launcher\Start-FamilyCastleClash.cmd','start.ps1')),
        (New-App -Name 'FutureU' -Aliases @('Future U') -Mode repo -Repo 'FutureU' -Candidates @('Start-App.ps1','start.ps1','launch.ps1')),
        (New-App -Name 'CRISPR Compass' -Aliases @('Crispr Compass') -Mode repo -Repo 'crispr-compass' -Candidates @('Start-App.ps1','start.ps1','launch.ps1')),
        (New-App -Name 'See You In Court' -Mode repo -Repo 'see-you-in-court' -Candidates @('Start-App.ps1','start.ps1','launch.ps1')),
        (New-App -Name 'ESPectre' -Aliases @('Espectre') -Mode repo -Repo 'espectre' -Candidates @('tools\web\Launch ESPectre.vbs','Start-App.ps1','start.ps1')),
        (New-App -Name 'Glimmer' -Mode repo -Repo 'glimmer' -Candidates @('Start-App.ps1','start.ps1','launch.ps1')),
        (New-App -Name 'GrantFlow' -Mode repo -Repo 'GrantFlow' -Candidates @('Start-App.ps1','start.ps1','launch.ps1','scripts\start.ps1')),
        (New-App -Name 'FlexFactor - GrantFlow' -Mode repo -Repo 'flexfactor' -Candidates @('flexfactor_launch.ps1') -ExtraArguments @('GrantFlow')),
        (New-App -Name 'FlexFactor - SermonSmith' -Mode repo -Repo 'flexfactor' -Candidates @('flexfactor_launch.ps1') -ExtraArguments @('sermonsmith')),
        (New-App -Name 'FlexFactor - GeneMap' -Mode repo -Repo 'flexfactor' -Candidates @('flexfactor_launch.ps1') -ExtraArguments @('genemap-discovery'))
    )
}

function Get-AppLookup {
    $lookup = @{}
    foreach ($app in Get-AppRegistry) {
        foreach ($name in @($app.Name) + @($app.Aliases)) {
            $lookup[(Normalize-Name $name)] = $app
        }
    }
    return $lookup
}

function Find-Browser {
    param([ValidateSet('edge','chrome','default')][string]$Browser)
    if ($Browser -eq 'default') { return $null }
    $candidates = if ($Browser -eq 'chrome') {
        @(
            (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
            (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
        )
    } else {
        @(
            (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
            (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
        )
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    return $null
}

function Start-WebApp {
    param([Parameter(Mandatory)][string]$Url,[ValidateSet('edge','chrome','default')][string]$Browser = 'edge')
    if ($Url -match '^https?://github\.com/') { throw "Refusing to use a GitHub repository page as an application target: $Url" }
    $exe = Find-Browser $Browser
    if ($exe) { Start-Process -FilePath $exe -ArgumentList @("--app=$Url") } else { Start-Process $Url }
}

function Quote-ProcessArgument {
    param([Parameter(Mandatory)][string]$Value)
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '"','\"') + '"'
}

function Start-LocalTarget {
    param([Parameter(Mandatory)][string]$Path,[string[]]$Arguments = @())
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $ext = [IO.Path]::GetExtension($Path).ToLowerInvariant()
    $working = Split-Path -Parent $Path
    $quotedPath = Quote-ProcessArgument $Path
    $quotedExtra = @($Arguments | ForEach-Object { Quote-ProcessArgument ([string]$_) })
    switch ($ext) {
        '.ps1' {
            $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $argLine = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$quotedPath) + $quotedExtra
            Start-Process -FilePath $ps -WorkingDirectory $working -ArgumentList $argLine
        }
        '.vbs' {
            $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
            Start-Process -FilePath $wscript -WorkingDirectory $working -ArgumentList (@($quotedPath) + $quotedExtra)
        }
        '.bat' {
            $cmd = Join-Path $env:SystemRoot 'System32\cmd.exe'
            Start-Process -FilePath $cmd -WorkingDirectory $working -ArgumentList (@('/c',$quotedPath) + $quotedExtra)
        }
        '.cmd' {
            $cmd = Join-Path $env:SystemRoot 'System32\cmd.exe'
            Start-Process -FilePath $cmd -WorkingDirectory $working -ArgumentList (@('/c',$quotedPath) + $quotedExtra)
        }
        '.pyw' {
            $pyw = Get-Command pythonw.exe -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($pyw) {
                Start-Process -FilePath $pyw.Source -WorkingDirectory $working -ArgumentList (@($quotedPath) + $quotedExtra)
            } else {
                $py = Get-Command py.exe -ErrorAction SilentlyContinue | Select-Object -First 1
                if (-not $py) { throw "Python was not found for $Path" }
                Start-Process -FilePath $py.Source -WorkingDirectory $working -ArgumentList (@('-3',$quotedPath) + $quotedExtra)
            }
        }
        '.py' {
            $py = Get-Command py.exe -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $py) { $py = Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1 }
            if (-not $py) { throw "Python was not found for $Path" }
            Start-Process -FilePath $py.Source -WorkingDirectory $working -ArgumentList (@($quotedPath) + $quotedExtra)
        }
        default { Start-Process -FilePath $Path -WorkingDirectory $working -ArgumentList $quotedExtra }
    }
    return $true
}

function Get-ManagedRepo {
    param([Parameter(Mandatory)][string]$Repo,[string]$Branch = 'main')
    if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { throw 'Git is required for a repository fallback, but git.exe was not found.' }
    $root = Join-Path $env:LOCALAPPDATA 'AxiomProgramSources'
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $path = Join-Path $root $Repo
    if (-not (Test-Path -LiteralPath (Join-Path $path '.git') -PathType Container)) {
        if (Test-Path -LiteralPath $path) { throw "Managed source path exists but is not a Git checkout: $path" }
        $cloneUrl = "https://github.com/$GitHubOwner/$Repo.git"
        & git clone --branch $Branch --single-branch $cloneUrl $path
        if ($LASTEXITCODE -ne 0 -and (Get-Command gh.exe -ErrorAction SilentlyContinue)) {
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
            & gh repo clone "$GitHubOwner/$Repo" $path -- --branch $Branch --single-branch
        }
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $path '.git'))) {
            throw "Could not clone the private repository $GitHubOwner/$Repo. GitHub authentication is required for repository fallbacks."
        }
    }
    & git -C $path fetch origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "Could not fetch $GitHubOwner/$Repo." }
    & git -C $path checkout $Branch
    if ($LASTEXITCODE -ne 0) { throw "Could not check out $Branch in $GitHubOwner/$Repo." }
    & git -C $path reset --hard "origin/$Branch"
    if ($LASTEXITCODE -ne 0) { throw "Could not reset $GitHubOwner/$Repo to origin/$Branch." }
    return $path
}

function Install-NodeDependenciesIfNeeded {
    param([Parameter(Mandatory)][string]$RepoPath)
    $packagePath = Join-Path $RepoPath 'package.json'
    if (-not (Test-Path -LiteralPath $packagePath)) { return }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { return }
    $sha = (& git -C $RepoPath rev-parse HEAD).Trim()
    $marker = Join-Path $RepoPath '.axiom-launcher-node-sha'
    if ((Test-Path -LiteralPath $marker) -and ((Get-Content -LiteralPath $marker -Raw).Trim() -eq $sha)) { return }
    Push-Location $RepoPath
    try {
        if (Test-Path -LiteralPath (Join-Path $RepoPath 'package-lock.json')) { & npm.cmd ci } else { & npm.cmd install }
        if ($LASTEXITCODE -ne 0) { throw "npm dependency installation failed in $RepoPath." }
        Set-Content -LiteralPath $marker -Value $sha -Encoding ascii
    } finally { Pop-Location }
}

function Start-RepoFallback {
    param([Parameter(Mandatory)]$App)
    $repoPath = Get-ManagedRepo -Repo $App.Repo -Branch $App.Branch
    foreach ($relative in $App.Candidates) {
        $candidate = Join-Path $repoPath $relative
        if (Start-LocalTarget -Path $candidate -Arguments $App.ExtraArguments) { return }
    }
    foreach ($relative in @('.codex\start.ps1','Start-App.ps1','start.ps1','launch.ps1','run.ps1','scripts\start.ps1','launch.vbs','launch.bat','launch.cmd')) {
        $candidate = Join-Path $repoPath $relative
        if (Start-LocalTarget -Path $candidate -Arguments $App.ExtraArguments) { return }
    }
    $packagePath = Join-Path $repoPath 'package.json'
    if (Test-Path -LiteralPath $packagePath) {
        Install-NodeDependenciesIfNeeded $repoPath
        $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
        $scriptNames = @()
        if ($package.PSObject.Properties.Name -contains 'scripts' -and $package.scripts) { $scriptNames = @($package.scripts.PSObject.Properties.Name) }
        $scriptName = if ($scriptNames -contains 'start') { 'start' } elseif ($scriptNames -contains 'dev') { 'dev' } else { '' }
        if ($scriptName) {
            $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $command = "Set-Location -LiteralPath '$($repoPath.Replace("'","''"))'; npm run $scriptName"
            Start-Process -FilePath $ps -WorkingDirectory $repoPath -ArgumentList @('-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-Command',$command)
            return
        }
    }
    foreach ($relative in @('app.py','main.py','src\main.py')) {
        $candidate = Join-Path $repoPath $relative
        if (Start-LocalTarget -Path $candidate -Arguments $App.ExtraArguments) { return }
    }
    throw "The shortcut was repaired, but no runnable application entry point was found for $($App.Name) in $repoPath."
}

function Start-AxiomApp {
    param([Parameter(Mandatory)][string]$Name)
    $lookup = Get-AppLookup
    $key = Normalize-Name $Name
    if (-not $lookup.ContainsKey($key)) { throw "Unknown Axiom application shortcut: $Name" }
    $app = $lookup[$key]
    if ($app.Mode -eq 'web') { Start-WebApp -Url $app.Url -Browser $app.Browser; return }
    if ($app.Target -and (Start-LocalTarget -Path $app.Target -Arguments $app.ExtraArguments)) { return }
    if (-not $app.Repo) { throw "The verified local target is missing for $($app.Name): $($app.Target)" }
    Start-RepoFallback -App $app
}

function Install-ShortcutRepairs {
    $launcherRoot = Join-Path $env:LOCALAPPDATA 'AxiomProgramLaunchers'
    New-Item -ItemType Directory -Force -Path $launcherRoot | Out-Null
    $installedLauncher = Join-Path $launcherRoot 'AxiomAppLauncher.ps1'
    $sourcePath = $PSCommandPath
    if (-not $sourcePath) { throw 'The repair script must be run from a .ps1 file.' }
    if ([IO.Path]::GetFullPath($sourcePath) -ine [IO.Path]::GetFullPath($installedLauncher)) { Copy-Item -LiteralPath $sourcePath -Destination $installedLauncher -Force }
    $folders = @($ShortcutFolders | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } | Select-Object -Unique)
    if ($folders.Count -eq 0) { throw 'No shortcut folder was found.' }
    $lookup = Get-AppLookup
    $shell = New-Object -ComObject WScript.Shell
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupPath = Join-Path $launcherRoot "shortcut-backup-$timestamp.csv"
    $results = New-Object System.Collections.Generic.List[object]
    foreach ($folder in $folders) {
        foreach ($file in Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -File -ErrorAction SilentlyContinue) {
            $key = Normalize-Name $file.BaseName
            if (-not $lookup.ContainsKey($key)) { continue }
            $app = $lookup[$key]
            $shortcut = $shell.CreateShortcut($file.FullName)
            $oldTarget = [string]$shortcut.TargetPath
            $oldArgs = [string]$shortcut.Arguments
            $oldWorking = [string]$shortcut.WorkingDirectory
            $oldIcon = [string]$shortcut.IconLocation
            $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $newArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + $installedLauncher + '" -AppName "' + $app.Name.Replace('"','""') + '"'
            $shortcut.TargetPath = $powershell
            $shortcut.Arguments = $newArgs
            $shortcut.WorkingDirectory = $launcherRoot
            if ($oldIcon) { $shortcut.IconLocation = $oldIcon }
            $shortcut.Description = "Open $($app.Name)"
            $shortcut.Save()
            $check = $shell.CreateShortcut($file.FullName)
            $valid = (([string]$check.TargetPath -ieq $powershell) -and ([string]$check.Arguments -like "*$installedLauncher*") -and ([string]$check.Arguments -notmatch 'https?://github\.com/'))
            if (-not $valid) { throw "Shortcut verification failed: $($file.FullName)" }
            $results.Add([pscustomobject]@{Shortcut=$file.FullName;Application=$app.Name;OldTarget=$oldTarget;OldArguments=$oldArgs;OldWorkingDirectory=$oldWorking;NewTarget=$check.TargetPath;NewArguments=$check.Arguments;Status='REPAIRED'})
        }
        foreach ($file in Get-ChildItem -LiteralPath $folder -Filter '*.url' -File -ErrorAction SilentlyContinue) {
            $key = Normalize-Name $file.BaseName
            if (-not $lookup.ContainsKey($key)) { continue }
            $app = $lookup[$key]
            if ($app.Mode -ne 'web') { continue }
            if ($app.Url -match '^https?://github\.com/') { throw "Invalid web-app target for $($app.Name)." }
            $old = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
            Set-Content -LiteralPath $file.FullName -Encoding ascii -Value @('[InternetShortcut]',"URL=$($app.Url)")
            $results.Add([pscustomobject]@{Shortcut=$file.FullName;Application=$app.Name;OldTarget=$old;OldArguments='';OldWorkingDirectory='';NewTarget=$app.Url;NewArguments='';Status='REPAIRED'})
        }
    }
    $results | Export-Csv -LiteralPath $backupPath -NoTypeInformation -Encoding UTF8
    if ($results.Count -eq 0) {
        Write-Warning 'No recognized Axiom application shortcuts were found.'
    } else {
        $results | Format-Table Application, Status, Shortcut -AutoSize
        Write-Host ''
        Write-Host "Repaired $($results.Count) shortcut(s)." -ForegroundColor Green
        Write-Host "Backup/report: $backupPath" -ForegroundColor Green
        Write-Host "Durable launcher: $installedLauncher" -ForegroundColor Green
        Write-Host 'GitHub repository pages are no longer used as app launch targets.' -ForegroundColor Green
    }
}

if ($AppName) { Start-AxiomApp -Name $AppName; exit }
Install-ShortcutRepairs
if (-not $InstallOnly) {
    Write-Host ''
    Write-Host 'Repair complete. You can now launch the apps from their existing icons.' -ForegroundColor Cyan
}
