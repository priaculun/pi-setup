# bootstrap.ps1 — Windows 11: install prerequisites + tools, then apply the Pi setup.
#
#   powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1            # everything
#   powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1 -Tools     # tools only
#   powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1 -Check     # report only
#
# Uses winget for git (incl. Git Bash, needed by pr-gate), gh, jq and Node.js LTS.
[CmdletBinding()]
param([switch]$Tools, [switch]$Check)
$ErrorActionPreference = "Stop"
$RepoDir = $PSScriptRoot

function Say($m)  { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "warn: $m" -ForegroundColor Yellow }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Refresh-Path {
  # winget installs update the registry PATH; reload it into this session.
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path", "User")
  $extra = @("$env:USERPROFILE\.local\bin", "$env:USERPROFILE\.pi\agent\bin", "$env:ProgramFiles\Git\bin")
  foreach ($p in $extra) { if ((Test-Path $p) -and ($env:Path -notlike "*$p*")) { $env:Path += ";$p" } }
}
function Node-Ok {
  if (-not (Have node)) { return $false }
  node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)"
  return ($LASTEXITCODE -eq 0)
}
Refresh-Path

$tools = "git", "gh", "jq", "node", "pi", "herdr", "tsk", "codebase-memory-mcp"
if ($Check) {
  foreach ($t in $tools) { if (Have $t) { "  ok       $t" } else { "  missing  $t" } }
  if (-not (Node-Ok)) { "  node >= 22.19 required" }
  exit 0
}

if (-not (Have winget)) { throw "winget not found. Install 'App Installer' from the Microsoft Store." }
$winget = @{ git = "Git.Git"; gh = "GitHub.cli"; jq = "jqlang.jq" }
foreach ($k in $winget.Keys) {
  if (-not (Have $k)) {
    Say "install $k"
    winget install --id $winget[$k] -e --source winget --accept-package-agreements --accept-source-agreements
  }
}
if (-not (Node-Ok)) {
  Say "install Node.js LTS"
  winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
}
Refresh-Path
if (-not (Node-Ok)) { throw "Node.js >= 22.19 not on PATH. Open a new terminal and re-run." }

if (-not (Have pi)) {
  Say "install Pi"
  Invoke-RestMethod https://pi.dev/install.ps1 | Invoke-Expression
  Refresh-Path
}
if (-not (Have herdr)) {
  Say "install herdr"
  Invoke-RestMethod https://herdr.dev/install.ps1 | Invoke-Expression
  Refresh-Path
}
if (-not (Have tsk)) {
  Say "install tsk"
  Invoke-RestMethod https://www.gettsk.sh/install.ps1 | Invoke-Expression
  Refresh-Path
}
if (-not (Have codebase-memory-mcp)) {
  Say "install codebase-memory-mcp"
  $tmp = Join-Path $env:TEMP "cbm-install.ps1"
  Invoke-WebRequest -Uri https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 -OutFile $tmp
  powershell -ExecutionPolicy Bypass -File $tmp
  Remove-Item $tmp -ErrorAction SilentlyContinue
  Refresh-Path
}

# ~/.local/bin holds pr-gate (+ pr-gate.cmd shim); make sure it is on the user PATH.
$localBin = "$env:USERPROFILE\.local\bin"
New-Item -ItemType Directory -Force -Path $localBin | Out-Null
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$localBin*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$localBin", "User")
  Say "added $localBin to user PATH"
}
Refresh-Path

if ($Tools) { Say "tools done"; exit 0 }

gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
  Warn "gh is not logged in — needed to pull secrets from the private repo."
  gh auth login
}

Say "apply Pi setup"
node "$RepoDir\scripts\setup.mjs" apply
