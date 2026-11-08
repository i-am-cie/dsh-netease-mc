<#
.SYNOPSIS
    Installer for dsh-netease-mc: checks the toolchain, installs bridge
    dependencies, creates the bridge config template and registers the
    netease mc MCP server in the DSH desktop profile.

.DESCRIPTION
    Idempotent. Running it twice is safe: the cordis.patch.yml entry is
    replaced in place (after a timestamped backup) instead of duplicated.
    Use -DryRun to print every action without touching the disk.

    Windows PowerShell 5.1 and PowerShell 7+ are both supported.

.PARAMETER GameDir
    NetEase Minecraft Java edition game instance directory.
    Default: D:\netease_minecraft_neoforge

.PARAMETER RepoRoot
    Repository root that contains packages/bridge. Default: parent of scripts/.

.PARAMETER NodeExe
    Absolute path to node.exe. Default: resolved from PATH.

.PARAMETER DshHome
    DSH home directory. Default: %USERPROFILE%\.dsh

.PARAMETER Profile
    DSH profile name. Default: desktop

.PARAMETER ConfigPath
    Bridge config path. Default: %USERPROFILE%\.dsh-mc\config.json

.PARAMETER SkipNpm
    Do not run npm install.

.PARAMETER NoDshConfig
    Do not touch cordis.patch.yml.

.PARAMETER InstallMod
    Copy the built mod jar from packages/mod into <GameDir>\mods.

.PARAMETER DryRun
    Print the planned actions only.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -GameDir D:\netease_minecraft_neoforge
#>
[CmdletBinding()]
param(
    [string]$GameDir = 'D:\netease_minecraft_neoforge',
    [string]$RepoRoot = '',
    [string]$NodeExe = '',
    [string]$DshHome = '',
    [string]$Profile = 'desktop',
    [string]$ConfigPath = '',
    [switch]$SkipNpm,
    [switch]$NoDshConfig,
    [switch]$InstallMod,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$Script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info([string]$Message) {
    Write-Host "    $Message"
}

function Write-Warn([string]$Message) {
    Write-Host "    [warn] $Message" -ForegroundColor Yellow
}

function Write-Err([string]$Message) {
    Write-Host "    [error] $Message" -ForegroundColor Red
}

function Get-FullPath([string]$Path) {
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Path))
}

function ConvertTo-YamlSingleQuoted([string]$Value) {
    # YAML single quoted scalars escape a single quote by doubling it.
    return "'" + ($Value -replace "'", "''") + "'"
}

function Get-NodeInfo([string]$ExplicitPath) {
    $candidate = $null
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (Test-Path -LiteralPath $ExplicitPath) {
            $candidate = (Resolve-Path -LiteralPath $ExplicitPath).Path
        } else {
            $cmd = Get-Command $ExplicitPath -ErrorAction SilentlyContinue
            if ($null -ne $cmd) { $candidate = $cmd.Source }
        }
    } else {
        $cmd = Get-Command node -ErrorAction SilentlyContinue
        if ($null -ne $cmd) { $candidate = $cmd.Source }
    }
    if ($null -eq $candidate) { return $null }
    $version = (& $candidate --version) 2>$null
    return [pscustomobject]@{ Path = $candidate; Version = [string]$version }
}

function Find-Javac {
    $candidates = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($env:JAVA_HOME)) {
        $candidates.Add((Join-Path (Join-Path $env:JAVA_HOME 'bin') 'javac.exe'))
    }
    $candidates.Add('D:\MCLDownload\ext\jre-v64-220420\jdk22\bin\javac.exe')
    $cmd = Get-Command javac -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { $candidates.Add($cmd.Source) }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Get-YamlPatchPath {
    return (Join-Path (Join-Path (Join-Path $DshHome 'profiles') $Profile) 'cordis.patch.yml')
}

function Get-EntryIdPattern {
    return '^-\s+id:\s*["'']?mcp-netease-mc["'']?\s*(#.*)?$'
}

function Get-DshEntryLines([string]$ResolvedNode, [string]$BridgeEntry, [string]$ResolvedConfig) {
    $q = "'"
    return @(
        '- id: mcp-netease-mc',
        '  name: "@deepseek-ai/dsh-mcp-client"',
        '  config:',
        '    serverName: neteasemc',
        '    transport: stdio',
        ('    command: ' + (ConvertTo-YamlSingleQuoted $ResolvedNode)),
        '    args:',
        ('      - ' + (ConvertTo-YamlSingleQuoted $BridgeEntry)),
        '    env:',
        ('      DSH_MC_CONFIG: ' + (ConvertTo-YamlSingleQuoted $ResolvedConfig))
    )
}

function Build-PatchedYaml([string[]]$Lines, [string[]]$EntryLines, [string]$NewLine) {
    $idPattern = Get-EntryIdPattern
    $kept = New-Object System.Collections.Generic.List[string]
    $i = 0
    while ($i -lt $Lines.Count) {
        if ($Lines[$i] -match $idPattern) {
            # Drop the whole top level entry: its continuation lines are indented
            # or blank; stop at the next top level list item.
            $i++
            while ($i -lt $Lines.Count -and $Lines[$i] -notmatch '^-\s+') {
                $i++
            }
            continue
        }
        $kept.Add($Lines[$i])
        $i++
    }
    while ($kept.Count -gt 0 -and [string]::IsNullOrWhiteSpace($kept[$kept.Count - 1])) {
        $kept.RemoveAt($kept.Count - 1)
    }
    $result = New-Object System.Collections.Generic.List[string]
    foreach ($line in $kept) { $result.Add($line) }
    foreach ($line in $EntryLines) { $result.Add($line) }
    return (($result -join $NewLine) + $NewLine)
}

function Read-TextFile([string]$Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        return $Script:Utf8NoBom.GetString($bytes, 3, $bytes.Length - 3)
    }
    return $Script:Utf8NoBom.GetString($bytes)
}

function Write-TextFile([string]$Path, [string]$Text) {
    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    [System.IO.File]::WriteAllText($Path, $Text, $Script:Utf8NoBom)
}

function Backup-File([string]$Path) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$Path.bak-$stamp"
    if ($DryRun) {
        Write-Info "[dry-run] would backup $Path -> $backup"
        return $backup
    }
    Copy-Item -LiteralPath $Path -Destination $backup -Force
    Write-Info "backup: $backup"
    return $backup
}

function Save-DshEntry([string]$ResolvedNode, [string]$BridgeEntry, [string]$ResolvedConfig) {
    $patchPath = Get-YamlPatchPath
    $newLine = "`n"
    $original = ''
    $hasFile = $false
    if (Test-Path -LiteralPath $patchPath) {
        $hasFile = $true
        $original = Read-TextFile $patchPath
        if ($original.Contains("`r`n")) { $newLine = "`r`n" }
    } else {
        Write-Warn "cordis.patch.yml not found, a new file will be created: $patchPath"
    }

    $entryLines = Get-DshEntryLines $ResolvedNode $BridgeEntry $ResolvedConfig
    if ($hasFile) {
        $lines = $original -split "\r?\n"
        $candidate = Build-PatchedYaml $lines $entryLines $newLine
    } else {
        $header = @(
            '# Your patch layer for this dsh profile, applied after every bundle layer:',
            '# a top-level YAML array of loader patch entries.'
        )
        $candidate = (($header + $entryLines) -join $newLine) + $newLine
    }

    $idPattern = Get-EntryIdPattern
    $matches = [regex]::Matches($candidate, $idPattern, 'Multiline')
    if ($matches.Count -ne 1) {
        throw "internal error: expected exactly one mcp-netease-mc entry, found $($matches.Count)"
    }

    if ($hasFile -and ($candidate -eq $original)) {
        Write-Info "cordis.patch.yml already up to date (no write, no backup)"
        return $patchPath
    }

    if ($DryRun) {
        Write-Info "[dry-run] planned entry in ${patchPath}:"
        foreach ($line in $entryLines) { Write-Host "        $line" }
        return $patchPath
    }

    if ($hasFile) { Backup-File $patchPath | Out-Null }
    Write-TextFile $patchPath $candidate
    Write-Info "updated: $patchPath"
    return $patchPath
}

function Save-ConfigTemplate([string]$ResolvedConfig) {
    if (Test-Path -LiteralPath $ResolvedConfig) {
        Write-Info "config already exists, left untouched: $ResolvedConfig"
        return $false
    }
    $config = [ordered]@{
        mode  = 'bot'
        bot   = [ordered]@{
            host             = '127.0.0.1'
            port             = 25565
            username         = 'DeepSeek'
            version          = '1.21.8'
            auth             = 'offline'
            connectTimeoutMs = 20000
        }
        mod   = [ordered]@{
            url       = 'http://127.0.0.1:38210'
            token     = ''
            timeoutMs = 5000
        }
        policy = [ordered]@{
            allowRead       = $true
            allowMove       = $true
            allowWorldWrite = $true
            allowCommands   = $true
            allowChat       = $true
            allowAttack     = $true
        }
        agent  = [ordered]@{
            baseUrl     = 'https://api.deepseek.com'
            model       = 'deepseek-chat'
            apiKeyEnv   = 'DEEPSEEK_API_KEY'
            maxSteps    = 40
            temperature = 0.3
        }
        log    = [ordered]@{ level = 'info'; file = '' }
    }
    $json = ConvertTo-Json -InputObject $config -Depth 8
    if ($DryRun) {
        Write-Info "[dry-run] would create config template: $ResolvedConfig"
        Write-Host $json
        return $true
    }
    Write-TextFile $ResolvedConfig $json
    Write-Info "created config template: $ResolvedConfig"
    return $true
}

function Invoke-NpmInstall([string]$BridgeDir) {
    $packageJson = Join-Path $BridgeDir 'package.json'
    if (-not (Test-Path -LiteralPath $packageJson)) {
        Write-Warn "bridge package.json not found yet: $packageJson (skip npm install)"
        return
    }
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if ($null -eq $npm) {
        throw 'npm was not found on PATH. Install Node.js 18+ first.'
    }
    if ($DryRun) {
        Write-Info "[dry-run] would run: npm install --omit=dev (cwd: $BridgeDir)"
        return
    }
    Push-Location $BridgeDir
    try {
        Write-Info "running npm install --omit=dev in $BridgeDir"
        & $npm.Source install --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

function Install-ModJar([string]$ResolvedGameDir) {
    $modsDir = Join-Path $ResolvedGameDir 'mods'
    $searchRoots = @(
        (Join-Path $RepoRoot 'packages\mod\build\libs'),
        (Join-Path $RepoRoot 'packages\mod\out'),
        (Join-Path $RepoRoot 'packages\mod\build')
    )
    $jar = $null
    foreach ($root in $searchRoots) {
        if (Test-Path -LiteralPath $root) {
            $candidate = Get-ChildItem -LiteralPath $root -Filter '*.jar' -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -notmatch 'sources|javadoc' } |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1
            if ($null -ne $candidate) { $jar = $candidate; break }
        }
    }
    if ($null -eq $jar) {
        throw "no mod jar found under packages/mod (build it first, or omit -InstallMod)"
    }
    if (-not (Test-Path -LiteralPath $modsDir)) {
        if ($DryRun) {
            Write-Info "[dry-run] would create mods directory: $modsDir"
        } else {
            New-Item -ItemType Directory -Path $modsDir -Force | Out-Null
        }
    }
    if ($DryRun) {
        Write-Info "[dry-run] would copy $($jar.FullName) -> $modsDir"
        return
    }
    $listing = Join-Path $modsDir 'mods-before-dsh-install.txt'
    if (-not (Test-Path -LiteralPath $listing)) {
        Get-ChildItem -LiteralPath $modsDir -File | ForEach-Object { $_.Name } | Set-Content -LiteralPath $listing -Encoding UTF8
    }
    Copy-Item -LiteralPath $jar.FullName -Destination $modsDir -Force
    Write-Info "installed mod: $(Join-Path $modsDir $jar.Name)"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

Write-Host 'dsh-netease-mc installer'
Write-Host "dry-run: $DryRun"
Write-Host "game dir: $GameDir"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = Get-FullPath $RepoRoot
$GameDir = Get-FullPath $GameDir

if ([string]::IsNullOrWhiteSpace($DshHome)) {
    if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        throw 'USERPROFILE is not set; pass -DshHome explicitly.'
    }
    $DshHome = Join-Path $env:USERPROFILE '.dsh'
}
$DshHome = Get-FullPath $DshHome

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        throw 'USERPROFILE is not set; pass -ConfigPath explicitly.'
    }
    $ConfigPath = Join-Path (Join-Path $env:USERPROFILE '.dsh-mc') 'config.json'
}
$ConfigPath = Get-FullPath $ConfigPath

$bridgeDir = Join-Path $RepoRoot 'packages\bridge'
$bridgeEntry = Join-Path $bridgeDir 'src\index.js'

Write-Step 'Checking Node.js'
$node = Get-NodeInfo $NodeExe
if ($null -eq $node) {
    Write-Err 'Node.js was not found. Install Node.js 18+ (20/22/24 recommended) and retry.'
    exit 1
}
Write-Info "node: $($node.Path) $($node.Version)"
$nodeMajorText = (($node.Version -replace '^v', '') -split '\.')[0]
$nodeMajor = 0
if ([int]::TryParse($nodeMajorText, [ref]$nodeMajor) -eq $false) { $nodeMajor = 0 }
if ($nodeMajor -lt 20) {
    Write-Err "Node.js 20+ is required (found $($node.Version)); packages/bridge declares engines >=20."
    exit 1
}

Write-Step 'Checking JDK (only needed to build the optional mod)'
$javac = Find-Javac
if ($null -eq $javac) {
    Write-Warn 'javac not found. Channel A (bot) works without a JDK; install JDK 21/22 to build the mod.'
} else {
    $javacVersion = (& $javac -version) 2>&1
    Write-Info "javac: $javac ($javacVersion)"
}

Write-Step 'Checking game directory (informational)'
if (-not (Test-Path -LiteralPath $GameDir)) {
    Write-Warn "game directory does not exist: $GameDir (use -GameDir to override; only needed for channel B / LAN logs)"
} else {
    Write-Info "game directory: $GameDir"
    $modsDir = Join-Path $GameDir 'mods'
    if (Test-Path -LiteralPath $modsDir) {
        $neteaseJar = Get-ChildItem -LiteralPath $modsDir -Filter '*.jar' -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $neteaseJar) {
            Write-Info "mods directory detected (channel B possible)"
        }
    }
}

Write-Step 'Checking bridge entry'
if (Test-Path -LiteralPath $bridgeEntry) {
    Write-Info "bridge entry: $bridgeEntry"
} else {
    Write-Warn "bridge entry not found yet: $bridgeEntry (clone the full repo before registering DSH)"
}

if (-not $SkipNpm) {
    Write-Step 'Installing bridge dependencies'
    Invoke-NpmInstall $bridgeDir
} else {
    Write-Step 'Skipping npm install (-SkipNpm)'
}

Write-Step 'Preparing bridge config'
$created = Save-ConfigTemplate $ConfigPath
if ($created -and -not $DryRun) {
    Write-Info 'The template uses port 25565. For a "Open to LAN" world run scripts\detect-lan.ps1'
    Write-Info 'and set bot.port in the config before connecting.'
}

$patchPath = $null
if (-not $NoDshConfig) {
    Write-Step 'Registering MCP server in the DSH profile'
    $patchPath = Save-DshEntry $node.Path $bridgeEntry $ConfigPath
} else {
    Write-Step 'Skipping DSH profile registration (-NoDshConfig)'
}

if ($InstallMod) {
    Write-Step 'Installing the optional in-game mod'
    Install-ModJar $GameDir
}

Write-Step 'Done'
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Set DEEPSEEK_API_KEY only if you use the built-in agent loop:'
Write-Host '       setx DEEPSEEK_API_KEY "sk-..."'
Write-Host '  2. Start the game, load a world and click "Open to LAN" (channel A),'
Write-Host '     then run: powershell -ExecutionPolicy Bypass -File scripts\detect-lan.ps1'
Write-Host '     and put the detected port into the bot.port field of the config.'
Write-Host '  3. Restart DSH (or reload the profile) so it picks up cordis.patch.yml.'
Write-Host '  4. Ask DeepSeek: "call mcp__neteasemc__mc_status and tell me what you see".'
Write-Host '  5. Optional channel B: quit the game, copy the mod jar into mods\,'
Write-Host '     edit config.json (mode=mod, token from config\netease_mc_link.json), restart game.'
if ($null -ne $patchPath) {
    Write-Host ''
    Write-Host "DSH patch file: $patchPath"
}
Write-Host "Bridge config:  $ConfigPath"
Write-Host ''
