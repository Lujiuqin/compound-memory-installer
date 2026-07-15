[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('status', 'doctor', 'sync', 'review')]
  [string]$Command = 'status',

  [switch]$Backup,
  [switch]$Monthly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $root 'runtime\compound-memory\mcp\server.mjs'
$portableNode = Join-Path $root 'runtime\node\node.exe'

if (Test-Path -LiteralPath $portableNode) {
  $node = $portableNode
} else {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCommand) { throw 'Node.js is unavailable. Re-run the Compound Memory installer.' }
  $node = $nodeCommand.Source
}

if (-not (Test-Path -LiteralPath $server)) { throw "Compound Memory runtime is missing: $server" }

$arguments = @($server, '--cli', $Command)
if ($Backup) { $arguments += '--backup' }
if ($Monthly) { $arguments += '--monthly' }

& $node @arguments
exit $LASTEXITCODE

