# Launch pi with pi-claude-link loaded, for interactive testing (Windows PowerShell 5.1+).
#
# Requires pi on a supported Node (>= 20.19). If your `pi` runs on an older Node and
# crashes with the undici "markAsUncloneable" error, point PI_CMD at a good Node +
# pi's cli.js, e.g.:
#   $env:PI_CMD = "C:\nvm4w\v22.16.0\node.exe $(npm root -g)\@earendil-works\pi-coding-agent\dist\cli.js"
#   .\dev-run.ps1
$ErrorActionPreference = "Stop"
$Ext = Join-Path $PSScriptRoot "index.ts"
if ($env:PI_CMD) {
  $parts = $env:PI_CMD -split '\s+' | Where-Object { $_ }
  & $parts[0] @($parts[1..($parts.Length - 1)] + @("-e", $Ext) + $args)
  exit $LASTEXITCODE
}
& pi -e $Ext @args
exit $LASTEXITCODE
