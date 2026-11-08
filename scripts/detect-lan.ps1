<#
.SYNOPSIS
    Detects the "Open to LAN" port of the NetEase Minecraft Java edition
    client: reads logs/latest.log and inspects listening sockets owned by
    java/javaw processes, then prints a bridge config suggestion.

.DESCRIPTION
    Channel A (mineflayer bot) needs host/port of a world that was opened to
    LAN. This script finds the port from two independent sources:

      1. the game log line "Local game hosted on port <port>";
      2. TCP LISTENING sockets owned by java/javaw processes (fallback).

    It never changes any game or config file. Windows PowerShell 5.1 and
    PowerShell 7+ are supported.

.PARAMETER GameDir
    Game instance directory that contains logs\latest.log.
    Default: D:\netease_minecraft_neoforge

.PARAMETER Json
    Emit machine readable JSON only.

.PARAMETER MaxLogAgeMinutes
    Warn when the newest log is older than this many minutes. Default: 120

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\detect-lan.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\detect-lan.ps1 -GameDir "D:\MyInstance" -Json
#>
[CmdletBinding()]
param(
    [string]$GameDir = 'D:\netease_minecraft_neoforge',
    [switch]$Json,
    [int]$MaxLogAgeMinutes = 120
)

$ErrorActionPreference = 'Stop'

function Write-Info([string]$Message) {
    if (-not $Json) { Write-Host $Message }
}

function Get-FullPath([string]$Path) {
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Path))
}

function Get-NewestLog([string]$ResolvedGameDir) {
    $logDir = Join-Path $ResolvedGameDir 'logs'
    $latest = Join-Path $logDir 'latest.log'
    if (Test-Path -LiteralPath $latest) { return $latest }
    if (Test-Path -LiteralPath $logDir) {
        $newest = Get-ChildItem -LiteralPath $logDir -Filter '*.log' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($null -ne $newest) { return $newest.FullName }
    }
    return $null
}

function Get-LogLanPorts([string]$LogPath) {
    $ports = New-Object System.Collections.Generic.List[int]
    if ($null -eq $LogPath) { return $ports }
    $patterns = @(
        'Local game hosted on port\s+(\d{2,5})',
        'Opening LAN on port\s+(\d{2,5})',
        'Opened to LAN on port\s+(\d{2,5})',
        'LAN server .*?port\s+(\d{2,5})'
    )
    foreach ($line in [System.IO.File]::ReadLines($LogPath)) {
        foreach ($pattern in $patterns) {
            $m = [regex]::Match($line, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
            if ($m.Success) {
                $port = 0
                if ([int]::TryParse($m.Groups[1].Value, [ref]$port) -and -not $ports.Contains($port)) {
                    $ports.Add($port)
                }
            }
        }
    }
    return $ports
}

function Get-JavaProcesses {
    $processes = @(Get-Process -Name 'javaw', 'java' -ErrorAction SilentlyContinue)
    return $processes
}

function Get-ListeningSockets {
    try {
        return @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
    } catch {
        return @()
    }
}

function Get-ListeningFromNetstat([int[]]$ProcessIds) {
    $results = New-Object System.Collections.Generic.List[object]
    $raw = & netstat -ano 2>$null
    foreach ($line in $raw) {
        $m = [regex]::Match([string]$line, '^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$')
        if (-not $m.Success) { continue }
        $local = $m.Groups[1].Value
        $pidValue = 0
        if ([int]::TryParse($m.Groups[2].Value, [ref]$pidValue) -eq $false) { continue }
        if ($ProcessIds.Count -gt 0 -and ($ProcessIds -notcontains $pidValue)) { continue }
        $idx = $local.LastIndexOf(':')
        if ($idx -lt 0) { continue }
        $port = 0
        if ([int]::TryParse($local.Substring($idx + 1), [ref]$port) -eq $false) { continue }
        if ($port -lt 1024 -or $port -gt 65535) { continue }
        $address = $local.Substring(0, $idx)
        $results.Add([pscustomobject]@{
            Port      = $port
            Address   = $address
            ProcessId = $pidValue
            Source    = 'netstat'
        })
    }
    return $results
}

function Get-JavaListeningPorts {
    $javaProcesses = Get-JavaProcesses
    $pidMap = @{}
    foreach ($p in $javaProcesses) { $pidMap[[int]$p.Id] = $p.ProcessName }
    $javaPids = @($javaProcesses | ForEach-Object { [int]$_.Id })

    $results = New-Object System.Collections.Generic.List[object]
    if ($javaPids.Count -eq 0) {
        # Without a running JVM every listening socket belongs to some other
        # application; reporting them as candidates would be misleading.
        return $results
    }
    $connections = Get-ListeningSockets
    if ($connections.Count -gt 0) {
        foreach ($conn in $connections) {
            $connPid = [int]$conn.OwningProcess
            if ($javaPids -notcontains $connPid) { continue }
            $port = [int]$conn.LocalPort
            if ($port -lt 1024 -or $port -gt 65535) { continue }
            $results.Add([pscustomobject]@{
                Port      = $port
                Address   = [string]$conn.LocalAddress
                ProcessId = $connPid
                Source    = 'Get-NetTCPConnection'
            })
        }
    } else {
        $results = Get-ListeningFromNetstat $javaPids
    }
    return $results
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

$GameDir = Get-FullPath $GameDir
$logPath = Get-NewestLog $GameDir
$logPorts = @(Get-LogLanPorts $logPath)
$javaProcesses = @(Get-JavaProcesses)
$listening = @(Get-JavaListeningPorts)

$candidates = New-Object System.Collections.Generic.List[object]
$seen = @{}
$logRank = @{}
$logIndex = 0
foreach ($port in $logPorts) {
    if (-not $seen.ContainsKey($port)) {
        $seen[$port] = $true
        # Later lines in latest.log are newer sessions; prefer them.
        $logRank[$port] = $logIndex
        $candidates.Add([pscustomobject]@{ port = [int]$port; source = 'latest.log'; confidence = 'high'; processId = 0; processName = '' })
    }
    $logIndex++
}
foreach ($socket in $listening) {
    if (-not $seen.ContainsKey([int]$socket.Port)) {
        $seen[[int]$socket.Port] = $true
        $procName = ''
        foreach ($p in $javaProcesses) {
            if ([int]$p.Id -eq [int]$socket.ProcessId) { $procName = $p.ProcessName }
        }
        $candidates.Add([pscustomobject]@{
            port        = [int]$socket.Port
            source      = [string]$socket.Source
            confidence  = 'medium'
            processId   = [int]$socket.ProcessId
            processName = $procName
        })
    }
}
$sorted = @($candidates | Sort-Object -Property `
    @{ Expression = { if ($_.confidence -eq 'high') { 0 } else { 1 } } }, `
    @{ Expression = { if ($logRank.ContainsKey([int]$_.port)) { [int]$logRank[[int]$_.port] } else { -1 } }; Descending = $true }, `
    port)
$best = $null
if ($sorted.Count -gt 0) { $best = $sorted[0] }

$logAgeMinutes = $null
if ($null -ne $logPath) {
    $logAgeMinutes = [int]((Get-Date) - (Get-Item -LiteralPath $logPath).LastWriteTime).TotalMinutes
}

if ($Json) {
    $result = [ordered]@{
        ok             = ($null -ne $best)
        host           = '127.0.0.1'
        port           = $(if ($null -ne $best) { [int]$best.port } else { $null })
        confidence     = $(if ($null -ne $best) { [string]$best.confidence } else { $null })
        candidates     = $sorted
        gameDir        = $GameDir
        logPath        = $logPath
        logAgeMinutes  = $logAgeMinutes
        javaProcesses  = @($javaProcesses | ForEach-Object { [pscustomobject]@{ id = [int]$_.Id; name = $_.ProcessName; path = $_.Path } })
        configSnippet  = $(if ($null -ne $best) { '{"bot":{"host":"127.0.0.1","port":' + [int]$best.port + ',"version":"1.21.8","auth":"offline"}}' } else { $null })
        generatedAt    = (Get-Date).ToString('s')
    }
    $result | ConvertTo-Json -Depth 6
    exit 0
}

Write-Host 'dsh-netease-mc LAN detector'
Write-Host ''
Write-Host "game dir : $GameDir"

if ($null -eq $logPath) {
    Write-Host 'log      : not found (expected <GameDir>\logs\latest.log)' -ForegroundColor Yellow
} else {
    $color = 'Gray'
    if ($null -ne $logAgeMinutes -and $logAgeMinutes -gt $MaxLogAgeMinutes) {
        $color = 'Yellow'
    }
    Write-Host "log      : $logPath (age: $logAgeMinutes min)" -ForegroundColor $color
}

if ($javaProcesses.Count -eq 0) {
    Write-Host 'java     : no javaw/java process found - start the game and load a world first.' -ForegroundColor Yellow
} else {
    $names = @($javaProcesses | ForEach-Object { "$($_.ProcessName)($($_.Id))" })
    Write-Host "java     : $($names -join ', ')"
}

if ($sorted.Count -eq 0) {
    Write-Host ''
    Write-Host 'No LAN port detected.' -ForegroundColor Yellow
    Write-Host 'Checklist:'
    Write-Host '  1. Load a world, press Esc, click "Open to LAN".'
    Write-Host '  2. Keep the log path above correct (use -GameDir if the instance moved).'
    Write-Host '  3. Minecraft LAN is usually published on an ephemeral port (>= 10000);'
    Write-Host '     netstat needs the game to still be running.'
    exit 2
}

Write-Host ''
Write-Host 'Candidates (best first):'
$rank = 1
foreach ($candidate in $sorted) {
    $extra = ''
    if ($candidate.processId -ne 0) { $extra = " pid=$($candidate.processId) $($candidate.processName)" }
    Write-Host ("  {0}. port {1}  [{2}/{3}]{4}" -f $rank, $candidate.port, $candidate.source, $candidate.confidence, $extra)
    $rank++
}

$best = $sorted[0]
Write-Host ''
Write-Host 'Suggested bridge config (channel A):' -ForegroundColor Green
Write-Host ('  "bot": { "host": "127.0.0.1", "port": ' + [int]$best.port + ', "version": "1.21.8", "auth": "offline" }')
Write-Host ''
Write-Host 'Or test it directly:'
Write-Host ('  node packages\bridge\src\index.js doctor')
Write-Host ('  # after editing %USERPROFILE%\.dsh-mc\config.json: "port": ' + [int]$best.port + ', "mode": "bot"')
Write-Host ''
Write-Host 'Note: the LAN port is random for every "Open to LAN" session. Re-run this'
Write-Host 'script (or install.ps1 with the new port) after reopening the world.'
