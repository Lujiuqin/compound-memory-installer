[CmdletBinding()]
param(
  [string]$InstallerRepository = 'Lujiuqin/compound-memory-installer',
  [string]$Version = 'v0.1.1',
  [string]$VaultRepository = '',
  [string]$VaultPath = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Obsidian\记忆系统'),
  [string]$SourceRoot = '',
  [switch]$LocalOnly,
  [switch]$InstallGhOnly,
  [switch]$SkipObsidianOpen
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'

$homeRoot = Join-Path $env:USERPROFILE '.compound-memory'
$binRoot = Join-Path $homeRoot 'bin'
$runtimeRoot = Join-Path $homeRoot 'runtime'
$downloadRoot = Join-Path $homeRoot 'downloads'
$configPath = Join-Path $homeRoot 'config.json'

# Re-running the one-line installer upgrades the already configured Vault instead
# of cloning a second copy when Windows redirects the Documents known folder.
if (-not $PSBoundParameters.ContainsKey('VaultPath') -and (Test-Path -LiteralPath $configPath)) {
  try {
    $existingConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($existingConfig.vaultPath -and (Test-Path -LiteralPath $existingConfig.vaultPath)) {
      $VaultPath = [string]$existingConfig.vaultPath
    }
  } catch {
    Write-Warning "Existing Compound Memory config could not be read; using the system Documents folder. $($_.Exception.Message)"
  }
}

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Test-Command([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Add-UserPath([string]$PathValue) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($current -split ';' | Where-Object { $_ })
  if ($parts -notcontains $PathValue) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $PathValue) -join ';'), 'User')
  }
  if (($env:Path -split ';') -notcontains $PathValue) { $env:Path = "$PathValue;$env:Path" }
}

function Install-PortableNode {
  if (Test-Command 'node') { return (Get-Command node).Source }
  Write-Step 'Installing portable Node.js runtime'
  $version = 'v22.22.3'
  $zip = Join-Path $downloadRoot "node-$version-win-x64.zip"
  $extract = Join-Path $runtimeRoot 'node-extract'
  Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/node-$version-win-x64.zip" -OutFile $zip -UseBasicParsing
  if (Test-Path $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
  $source = Join-Path $extract "node-$version-win-x64"
  $target = Join-Path $runtimeRoot 'node'
  if (Test-Path $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  Move-Item -LiteralPath $source -Destination $target
  Remove-Item -LiteralPath $extract -Recurse -Force
  Add-UserPath $target
  return (Join-Path $target 'node.exe')
}

function Install-PortableGh {
  if (Test-Command 'gh') { return (Get-Command gh).Source }
  Write-Step 'Installing portable GitHub CLI'
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/cli/cli/releases/latest' -Headers @{ 'User-Agent' = 'compound-memory-installer' }
  $asset = $release.assets | Where-Object { $_.name -match 'windows_amd64\.zip$' } | Select-Object -First 1
  if (-not $asset) { throw 'Unable to locate the Windows GitHub CLI release asset.' }
  $zip = Join-Path $downloadRoot $asset.name
  $extract = Join-Path $runtimeRoot 'gh-extract'
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
  if (Test-Path $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
  $ghExe = Get-ChildItem -LiteralPath $extract -Recurse -Filter 'gh.exe' | Select-Object -First 1
  if (-not $ghExe) { throw 'Downloaded GitHub CLI archive did not contain gh.exe.' }
  $target = Join-Path $runtimeRoot 'gh'
  if (Test-Path $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Copy-Item -Path (Join-Path (Split-Path $ghExe.FullName -Parent) '*') -Destination $target -Recurse -Force
  Remove-Item -LiteralPath $extract -Recurse -Force
  Add-UserPath $target
  return (Join-Path $target 'gh.exe')
}

function Ensure-Git {
  if (Test-Command 'git') { return (Get-Command git).Source }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Step 'Installing Git with winget'
    & $winget.Source install --id Git.Git --exact --silent --accept-package-agreements --accept-source-agreements
    if (Test-Command 'git') { return (Get-Command git).Source }
  }
  throw 'Git is required. Install Git for Windows, then re-run this installer.'
}

function Get-SourceRoot {
  if ($SourceRoot) {
    $resolved = (Resolve-Path -LiteralPath $SourceRoot).Path
    if (-not (Test-Path (Join-Path $resolved 'plugins\compound-memory'))) { throw "Invalid SourceRoot: $resolved" }
    return $resolved
  }
  if ($InstallerRepository -eq '__INSTALLER_REPO__') { throw 'Installer repository owner has not been configured in this release.' }
  Write-Step "Downloading $InstallerRepository $Version"
  $archive = Join-Path $downloadRoot 'installer.zip'
  $extract = Join-Path $runtimeRoot 'installer-source'
  Invoke-WebRequest -Uri "https://github.com/$InstallerRepository/archive/refs/tags/$Version.zip" -OutFile $archive -UseBasicParsing
  if (Test-Path $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
  Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
  $root = Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1
  if (-not $root -or -not (Test-Path (Join-Path $root.FullName 'plugins\compound-memory'))) { throw 'Downloaded installer source is invalid.' }
  return $root.FullName
}

function Install-MemoryRuntime([string]$ResolvedSource, [string]$NodePath) {
  Write-Step 'Installing Compound Memory runtime and memoryctl'
  $pluginSource = Join-Path $ResolvedSource 'plugins\compound-memory'
  $pluginTarget = Join-Path $runtimeRoot 'compound-memory'
  if (Test-Path $pluginTarget) { Remove-Item -LiteralPath $pluginTarget -Recurse -Force }
  Copy-Item -LiteralPath $pluginSource -Destination $pluginTarget -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $ResolvedSource 'scripts\memoryctl.ps1') -Destination (Join-Path $binRoot 'memoryctl.ps1') -Force
  Copy-Item -LiteralPath (Join-Path $ResolvedSource 'scripts\memoryctl.cmd') -Destination (Join-Path $binRoot 'memoryctl.cmd') -Force
  Add-UserPath $binRoot
  if (-not (Test-Path -LiteralPath $NodePath)) { throw "Node runtime not found: $NodePath" }
}

function Install-PersonalMarketplace([string]$ResolvedSource) {
  Write-Step 'Installing the personal Codex marketplace fallback'
  $personalPluginRoot = Join-Path $env:USERPROFILE 'plugins'
  $personalPlugin = Join-Path $personalPluginRoot 'compound-memory'
  $marketplacePath = Join-Path $env:USERPROFILE '.agents\plugins\marketplace.json'
  New-Item -ItemType Directory -Force -Path $personalPluginRoot,(Split-Path $marketplacePath -Parent) | Out-Null
  if (Test-Path $personalPlugin) { Remove-Item -LiteralPath $personalPlugin -Recurse -Force }
  Copy-Item -LiteralPath (Join-Path $ResolvedSource 'plugins\compound-memory') -Destination $personalPlugin -Recurse -Force

  $entry = [ordered]@{
    name = 'compound-memory'
    source = [ordered]@{ source = 'local'; path = './plugins/compound-memory' }
    policy = [ordered]@{ installation = 'INSTALLED_BY_DEFAULT'; authentication = 'ON_USE' }
    category = 'Productivity'
  }
  if (Test-Path $marketplacePath) {
    $market = Get-Content -LiteralPath $marketplacePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $others = @($market.plugins | Where-Object { $_.name -ne 'compound-memory' })
    $market.plugins = @($others) + @($entry)
    if (-not $market.interface) { $market | Add-Member -NotePropertyName interface -NotePropertyValue ([ordered]@{ displayName = 'Personal' }) }
  } else {
    $market = [ordered]@{ name = 'personal'; interface = [ordered]@{ displayName = 'Personal' }; plugins = @($entry) }
  }
  $market | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $marketplacePath -Encoding UTF8
  return $marketplacePath
}

New-Item -ItemType Directory -Force -Path $homeRoot,$binRoot,$runtimeRoot,$downloadRoot | Out-Null
if ($InstallGhOnly) {
  $installedGh = Install-PortableGh
  Write-Host "GitHub CLI ready: $installedGh" -ForegroundColor Green
  exit 0
}
Write-Step 'Checking prerequisites'
if (-not (Test-Command 'codex')) { Write-Warning 'Codex CLI was not found. Vault and runtime will install, but plugin registration may require the Codex desktop plugin page.' }
$gitPath = Ensure-Git
$nodePath = Install-PortableNode
$source = Get-SourceRoot

$owner = ''
$ghPath = $null
if (-not $LocalOnly) {
  $ghPath = Install-PortableGh
  Write-Step 'Checking GitHub authentication'
  & $ghPath auth status *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'A browser will open for one-time GitHub device authentication.' -ForegroundColor Yellow
    & $ghPath auth login --web --git-protocol https
    if ($LASTEXITCODE -ne 0) { throw 'GitHub authentication was not completed.' }
  }
  $owner = (& $ghPath api user --jq '.login').Trim()
  $userId = (& $ghPath api user --jq '.id').Trim()
  if (-not $VaultRepository) { $VaultRepository = "$owner/obsidian-memory-system" }
  Write-Step "Connecting private vault $VaultRepository"
  $needsClone = $false
  if (Test-Path -LiteralPath $VaultPath) {
    $items = @(Get-ChildItem -LiteralPath $VaultPath -Force -ErrorAction SilentlyContinue)
    if ($items.Count -eq 0) {
      $needsClone = $true
    } else {
      $remote = (& $gitPath -C $VaultPath remote get-url origin 2>$null)
      if ($LASTEXITCODE -ne 0 -or $remote -notmatch [regex]::Escape($VaultRepository)) {
        throw "Target directory is non-empty and is not the expected repository: $VaultPath"
      }
    }
  } else {
    New-Item -ItemType Directory -Force -Path (Split-Path $VaultPath -Parent) | Out-Null
    $needsClone = $true
  }
  if ($needsClone) {
    & $ghPath repo clone $VaultRepository $VaultPath -- -c core.autocrlf=false
    if ($LASTEXITCODE -ne 0) { throw "Unable to clone private vault $VaultRepository" }
  }
  & $gitPath -C $VaultPath config user.name $owner
  & $gitPath -C $VaultPath config user.email "$userId+$owner@users.noreply.github.com"
  & $gitPath -C $VaultPath config pull.ff only
  & $gitPath -C $VaultPath config core.autocrlf false
  if ($needsClone) {
    $freshStatus = @(& $gitPath -C $VaultPath status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $freshStatus.Count -gt 0) {
      throw 'Fresh Vault clone is unexpectedly dirty. Installation stopped before opening Obsidian.'
    }
  }
} elseif (-not (Test-Path -LiteralPath $VaultPath)) {
  throw "LocalOnly requires an existing VaultPath: $VaultPath"
}

$deviceId = $env:COMPUTERNAME
$config = [ordered]@{
  version = '0.1.1'
  vaultPath = (Resolve-Path -LiteralPath $VaultPath).Path
  vaultRepository = $VaultRepository
  deviceId = $deviceId
  installedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding UTF8
Install-MemoryRuntime -ResolvedSource $source -NodePath $nodePath
$personalMarketplace = Install-PersonalMarketplace -ResolvedSource $source

if (Test-Command 'codex') {
  Write-Step 'Registering the Codex plugin'
  try {
    & codex plugin add 'compound-memory@personal'
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Plugin files are installed; confirm Compound Memory in Codex Plugins after restart.' }
  } catch {
    Write-Warning "Codex CLI registration was unavailable. The personal marketplace is ready at $personalMarketplace; restart Codex and confirm the plugin in Plugins."
  }
}

Write-Step 'Running Compound Memory doctor'
& $nodePath (Join-Path $runtimeRoot 'compound-memory\mcp\server.mjs') --cli doctor
if ($LASTEXITCODE -ne 0) { throw 'Compound Memory doctor failed.' }

if (-not $SkipObsidianOpen) {
  try {
    $encoded = [Uri]::EscapeDataString((Resolve-Path -LiteralPath $VaultPath).Path)
    Start-Process "obsidian://open?path=$encoded"
  } catch {
    Write-Warning "Open this folder as an Obsidian vault: $VaultPath"
  }
}

Write-Host "`nCompound Memory installation completed." -ForegroundColor Green
Write-Host "Vault: $VaultPath"
Write-Host "Device: $deviceId"
Write-Host 'Restart Codex and create a new task before using the plugin.'
Write-Host 'Run: memoryctl status'
