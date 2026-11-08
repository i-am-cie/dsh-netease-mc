#Requires -Version 5.1
<#
.SYNOPSIS
    Builds packages/mod into build/netease-mc-link-1.0.0.jar using only the local JDK and the
    jars already installed in the game instance (no Gradle, no network).

.DESCRIPTION
    Why no Gradle: the target machine has no Gradle and maven.neoforged.net times out. All
    classes needed for compilation are already present in D:\netease_minecraft_neoforge:
      * libraries\net\minecraft\client\<ver>\client-<ver>-srg.jar
            <-- despite the name, this jar carries the Mojang *official* member names that the
                NeoForge 21.8.52 runtime uses (verified with javap; see NOTES.md).
      * libraries\**\*.jar (NeoForge, FML loader, event bus, Gson, slf4j, ...)
    The vanilla/named-on-disk versions\1.21.8\1.21.8.jar has obfuscated members and is
    deliberately NOT used; -slim.jar is obfuscated as well and is excluded.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File packages\mod\build.ps1
    powershell -ExecutionPolicy Bypass -File packages\mod\build.ps1 -GameDir 'D:\some\other\instance'
#>
[CmdletBinding()]
param(
    [string]$GameDir = 'D:\netease_minecraft_neoforge',
    [string]$JdkHome = 'D:\MCLDownload\ext\jre-v64-220420\jdk22',
    [string]$OutDir,
    [switch]$KeepClasses
)

$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcJava = Join-Path $scriptRoot 'src\main\java'
$srcRes = Join-Path $scriptRoot 'src\main\resources'
if (-not $OutDir) { $OutDir = Join-Path $scriptRoot 'build' }

$jarName = 'netease-mc-link-1.0.0.jar'
$modVersion = '1.0.0'

function Fail([string]$message) {
    Write-Host "[build] ERROR: $message" -ForegroundColor Red
    exit 1
}

function Info([string]$message) {
    Write-Host "[build] $message" -ForegroundColor Cyan
}

# ---------------------------------------------------------------- toolchain
$javac = Join-Path $JdkHome 'bin\javac.exe'
$jarExe = Join-Path $JdkHome 'bin\jar.exe'
if (-not (Test-Path $javac)) { Fail "javac not found at '$javac' (use -JdkHome)" }
if (-not (Test-Path $jarExe)) { Fail "jar tool not found at '$jarExe' (use -JdkHome)" }

$javacVersion = (& $javac -version 2>&1) -join ' '
Info "javac: $javacVersion"

if (-not (Test-Path $GameDir)) { Fail "game directory not found: '$GameDir' (use -GameDir)" }
$libRoot = Join-Path $GameDir 'libraries'
if (-not (Test-Path $libRoot)) { Fail "libraries directory not found: '$libRoot'" }

# ------------------------------------------------------- game classpath
$srgJar = Get-ChildItem -Path $libRoot -Recurse -File -Filter '*-srg.jar' -ErrorAction SilentlyContinue |
    Sort-Object FullName | Select-Object -First 1
if (-not $srgJar) {
    Fail ("could not find a *-srg.jar under '$libRoot'. The official-named Minecraft classes are " +
        'required; run the NeoForge installer for this instance first.')
}
Info "official-named Minecraft jar: $($srgJar.FullName)"

$cpJars = New-Object System.Collections.Generic.List[string]
$cpJars.Add($srgJar.FullName)
Get-ChildItem -Path $libRoot -Recurse -File -Filter '*.jar' |
    Where-Object {
        $_.FullName -ne $srgJar.FullName -and
        $_.Name -notlike '*-slim.jar' -and      # obfuscated, would shadow official names
        $_.Name -notlike '*-extra.jar'          # assets only, harmless but pointless
    } |
    Sort-Object FullName |
    ForEach-Object { $cpJars.Add($_.FullName) }

$classpath = ($cpJars -join ';')
Info "classpath entries: $($cpJars.Count)"

# ------------------------------------------------------------- sources
if (-not (Test-Path $srcJava)) { Fail "source directory not found: '$srcJava'" }
$sources = @(Get-ChildItem -Path $srcJava -Recurse -File -Filter '*.java' | Sort-Object FullName)
if ($sources.Count -eq 0) { Fail "no .java sources under '$srcJava'" }
Info "sources: $($sources.Count)"

# ------------------------------------------------------------- output
$classesDir = Join-Path $OutDir 'classes'
if (Test-Path $OutDir) { Remove-Item -Path $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

# javac @argfile: forward slashes only - javac treats '\' as an escape character inside
# argfiles on Windows (observed: "找不到文件: C:Users18744...").
$argLines = @(
    '-encoding', 'UTF-8',
    '--release', '21',
    '-nowarn',
    '-proc:none',
    '-classpath', ('"' + $classpath.Replace('\', '/') + '"')
)
foreach ($source in $sources) {
    $argLines += ('"' + $source.FullName.Replace('\', '/') + '"')
}
$argFile = Join-Path $OutDir 'javac.args'
[System.IO.File]::WriteAllLines($argFile, $argLines, (New-Object System.Text.UTF8Encoding($false)))

Info 'compiling ...'
& $javac "@$argFile" -d $classesDir
if ($LASTEXITCODE -ne 0) { Fail "javac failed with exit code $LASTEXITCODE" }

# ---------------------------------------------------------- resources
if (Test-Path $srcRes) {
    Copy-Item -Path (Join-Path $srcRes '*') -Destination $classesDir -Recurse -Force
} else {
    Fail "resources directory not found: '$srcRes'"
}

# ---------------------------------------------------------------- jar
$outJar = Join-Path $OutDir $jarName
Info "packaging $jarName ..."
& $jarExe --create --file $outJar -C $classesDir .
if ($LASTEXITCODE -ne 0) { Fail "jar packaging failed with exit code $LASTEXITCODE" }

# ---------------------------------------------------------- validation
$entries = @(& $jarExe --list --file $outJar)
if ($LASTEXITCODE -ne 0) { Fail 'could not list the produced jar' }

$requiredEntries = @(
    'META-INF/MANIFEST.MF',
    'META-INF/neoforge.mods.toml',
    'com/dsh/mc/link/NeteaseMcLink.class',
    'com/dsh/mc/link/HttpBridge.class',
    'com/dsh/mc/link/Api.class'
)
foreach ($entry in $requiredEntries) {
    if ($entries -notcontains $entry) { Fail "jar validation failed: missing entry '$entry'" }
}

$checkDir = Join-Path $OutDir 'toml-check'
New-Item -ItemType Directory -Path $checkDir -Force | Out-Null
Push-Location $checkDir
try {
    & $jarExe --extract --file $outJar 'META-INF/neoforge.mods.toml' | Out-Null
} finally {
    Pop-Location
}
if ($LASTEXITCODE -ne 0) { Fail 'could not extract neoforge.mods.toml from the jar' }
$tomlPath = Join-Path $checkDir 'META-INF\neoforge.mods.toml'
if (-not (Test-Path $tomlPath)) { Fail 'neoforge.mods.toml missing after extraction' }
$toml = Get-Content -Path $tomlPath -Raw
if ($toml -notmatch 'modId\s*=\s*"netease_mc_link"') { Fail 'neoforge.mods.toml does not declare modId="netease_mc_link"' }
if ($toml -notmatch ('version\s*=\s*"' + [regex]::Escape($modVersion) + '"')) { Fail "neoforge.mods.toml does not declare version=$modVersion" }
Remove-Item -Path $checkDir -Recurse -Force

$classesCheck = @(& $jarExe --list --file $outJar | Where-Object { $_ -like '*.class' })
Info "class entries packaged: $($classesCheck.Count)"

if (-not $KeepClasses) {
    Remove-Item -Path $classesDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $argFile -Force -ErrorAction SilentlyContinue
}

$hash = (Get-FileHash -Path $outJar -Algorithm SHA256).Hash
$size = (Get-Item $outJar).Length
Info ''
Info "BUILD OK"
Write-Host ("  jar : {0}" -f $outJar)
Write-Host ("  size: {0} bytes ({1:N1} KiB)" -f $size, ($size / 1KB))
Write-Host ("  sha256: {0}" -f $hash)
Write-Host ("  install: copy to '{0}' and restart Minecraft" -f (Join-Path $GameDir 'mods'))
