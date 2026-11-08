<#
.SYNOPSIS
    Uninstaller for dsh-netease-mc: removes the mcp-netease-mc entry from the
    DSH profile patch file, validates the result and optionally deletes the
    bridge config directory.

.DESCRIPTION
    Idempotent. A timestamped .bak-<timestamp> copy of cordis.patch.yml is
    created before any modification. If the entry is not present nothing is
    written.

    Windows PowerShell 5.1 and PowerShell 7+ are supported.

.PARAMETER DshHome
    DSH home directory. Default: %USERPROFILE%\.dsh

.PARAMETER Profile
    DSH profile name. Default: desktop

.PARAMETER ConfigPath
    Bridge config path (file). Default: %USERPROFILE%\.dsh-mc\config.json

.PARAMETER RemoveData
    Also delete the bridge config directory (%USERPROFILE%\.dsh-mc).
    The directory is verified before it is removed.

.PARAMETER RemoveMod
    Also delete netease-mc-link*.jar from <GameDir>\mods.

.PARAMETER GameDir
    Game instance directory used by -RemoveMod.
    Default: D:\netease_minecraft_neoforge

.PARAMETER DryRun
    Print the planned actions only.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -DryRun

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -RemoveData
#>
[CmdletBinding()]
param(
    [string]$DshHome = '',
    [string]$Profile = 'desktop',
    [string]$ConfigPath = '',
    [string]$GameDir = 'D:\netease_minecraft_neoforge',
    [switch]$RemoveData,
    [switch]$RemoveMod,
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

function Get-FullPath([string]$Path) {
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Path))
}

function Get-EntryIdPattern {
    return '^-\s+id:\s*["'']?mcp-netease-mc["'']?\s*(#.*)?$'
}

function Read-TextFile([string]$Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        return $Script:Utf8NoBom.GetString($bytes, 3, $bytes.Length - 3)
    }
    return $Script:Utf8NoBom.GetString($bytes)
}

function Write-TextFile([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, $Script:Utf8NoBom)
}

function Remove-DshEntry([string]$PatchPath) {
    if (-not (Test-Path -LiteralPath $PatchPath)) {
        Write-Info "patch file does not exist, nothing to remove: $PatchPath"
        return $false
    }
    $original = Read-TextFile $PatchPath
    $newLine = "`n"
    if ($original.Contains("`r`n")) { $newLine = "`r`n" }

    $idPattern = Get-EntryIdPattern
    $lines = $original -split "\r?\n"
    $kept = New-Object System.Collections.Generic.List[string]
    $removed = 0
    $i = 0
    while ($i -lt $lines.Count) {
        if ($lines[$i] -match $idPattern) {
            $removed++
            $i++
            while ($i -lt $lines.Count -and $lines[$i] -notmatch '^-\s+') {
                $i++
            }
            continue
        }
        $kept.Add($lines[$i])
        $i++
    }

    if ($removed -eq 0) {
        Write-Info 'mcp-netease-mc entry not found (already uninstalled)'
        return $false
    }

    while ($kept.Count -gt 0 -and [string]::IsNullOrWhiteSpace($kept[$kept.Count - 1])) {
        $kept.RemoveAt($kept.Count - 1)
    }
    $newText = ($kept -join $newLine)
    if ($newText.Length -gt 0) { $newText = $newText + $newLine }

    # Validate the removal before writing: the id must be gone and no orphan
    # "name: @deepseek-ai/dsh-mcp-client" line may remain.
    if ($newText -match $idPattern) {
        throw 'internal error: mcp-netease-mc entry still present after removal'
    }
    if ($newText -match 'dsh-mcp-client') {
        throw 'internal error: orphan dsh-mcp-client reference remains; aborting without writing'
    }

    if ($DryRun) {
        Write-Info "[dry-run] would remove $removed entry/entries from $PatchPath"
        return $true
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$PatchPath.bak-$stamp"
    Copy-Item -LiteralPath $PatchPath -Destination $backup -Force
    Write-Info "backup: $backup"
    Write-TextFile $PatchPath $newText
    Write-Info "updated: $PatchPath (removed $removed entry/entries)"
    return $true
}

function Remove-BridgeData([string]$ResolvedConfig) {
    $dataDir = Split-Path -Parent $ResolvedConfig
    if ([string]::IsNullOrWhiteSpace($dataDir)) {
        throw "cannot derive data directory from config path: $ResolvedConfig"
    }
    $dataDir = Get-FullPath $dataDir
    if (-not (Test-Path -LiteralPath $dataDir)) {
        Write-Info "bridge data directory does not exist: $dataDir"
        return
    }
    # Safety: only delete a directory that really is a .dsh-mc config dir and
    # lives below the current user profile (or was passed explicitly).
    $leaf = Split-Path -Leaf $dataDir
    if ($leaf -ne '.dsh-mc') {
        Write-Warn "refusing to delete '$dataDir' (leaf is not .dsh-mc); delete it manually if intended"
        return
    }
    $profileRoot = Get-FullPath $env:USERPROFILE
    $prefix = $profileRoot.TrimEnd('\') + '\'
    if (-not $dataDir.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Warn "refusing to delete '$dataDir' (outside $profileRoot); delete it manually if intended"
        return
    }
    if ($DryRun) {
        Write-Info "[dry-run] would delete $dataDir"
        return
    }
    Remove-Item -LiteralPath $dataDir -Recurse -Force
    Write-Info "deleted: $dataDir"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

Write-Host 'dsh-netease-mc uninstaller'
Write-Host "dry-run: $DryRun"

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

$patchPath = Join-Path (Join-Path (Join-Path $DshHome 'profiles') $Profile) 'cordis.patch.yml'

Write-Step 'Removing MCP server registration'
Remove-DshEntry $patchPath | Out-Null

if ($RemoveMod) {
    Write-Step 'Removing the optional in-game mod'
    $GameDir = Get-FullPath $GameDir
    $modsDir = Join-Path $GameDir 'mods'
    if (Test-Path -LiteralPath $modsDir) {
        $jars = Get-ChildItem -LiteralPath $modsDir -Filter 'netease-mc-link*.jar' -File -ErrorAction SilentlyContinue
        if ($null -eq $jars -or @($jars).Count -eq 0) {
            Write-Info "no netease-mc-link*.jar under $modsDir"
        } else {
            foreach ($jar in @($jars)) {
                if ($DryRun) {
                    Write-Info "[dry-run] would delete $($jar.FullName)"
                } else {
                    Remove-Item -LiteralPath $jar.FullName -Force
                    Write-Info "deleted: $($jar.FullName)"
                }
            }
        }
    } else {
        Write-Info "mods directory does not exist: $modsDir"
    }
}

if ($RemoveData) {
    Write-Step 'Removing bridge config data'
    Remove-BridgeData $ConfigPath
} else {
    Write-Step 'Keeping bridge config data'
    Write-Info "config kept at: $ConfigPath (pass -RemoveData to delete)"
}

Write-Step 'Done'
Write-Host ''
Write-Host 'Restart DSH (or reload the profile) to drop the MCP server from the tool list.'
Write-Host ''
