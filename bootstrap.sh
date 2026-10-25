#!/usr/bin/env bash
# bootstrap.sh — install prerequisites + tools, then apply the Pi setup.
# Supports macOS (Homebrew), Ubuntu/Debian (apt), Arch/Omarchy (pacman).
#
#   ./bootstrap.sh            # everything
#   ./bootstrap.sh --tools    # prerequisites + tools only, no apply
#   ./bootstrap.sh --check    # print what is missing, change nothing
#
# Idempotent: every step is skipped when the tool is already present.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="all"
case "${1:-}" in
  --tools) MODE="tools" ;;
  --check) MODE="check" ;;
  ""|--all) ;;
  -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH"

# ---------------------------------------------------------------- platform
OS="$(uname -s)"
PM=""
if [ "$OS" = "Darwin" ]; then
  PM="brew"
elif [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case " ${ID:-} ${ID_LIKE:-} " in
    *" arch "*) PM="pacman" ;;
    *" debian "*|*" ubuntu "*) PM="apt" ;;
  esac
fi
[ -n "$PM" ] || die "unsupported OS ($OS ${ID:-}). Supported: macOS, Ubuntu/Debian, Arch/Omarchy. Windows: bootstrap.ps1"

SUDO=""
if [ "$(id -u)" -ne 0 ] && [ "$PM" != "brew" ]; then SUDO="sudo"; fi

node_ok() {
  have node && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)'
}

# ---------------------------------------------------------------- check mode
if [ "$MODE" = "check" ]; then
  say "platform: $OS ($PM)"
  for t in git curl jq gh node pi herdr tsk codebase-memory-mcp; do
    if have "$t"; then printf '  ok       %s\n' "$t"; else printf '  missing  %s\n' "$t"; fi
  done
  node_ok || echo "  node >= 22.19 required"
  exit 0
fi

# ---------------------------------------------------------------- prerequisites
pkg_install() {
  case "$PM" in
    brew)   brew install "$@" ;;
    apt)    $SUDO apt-get install -y "$@" ;;
    pacman) $SUDO pacman -S --needed --noconfirm "$@" ;;
  esac
}

if [ "$PM" = "brew" ] && ! have brew; then
  die "Homebrew is required on macOS: https://brew.sh"
fi
# Refresh package indexes once. Arch: full -Syu avoids partial upgrades (unsupported on Arch).
case "$PM" in
  apt)    $SUDO apt-get update -y ;;
  pacman) $SUDO pacman -Syu --noconfirm ;;
esac

for t in git curl jq; do have "$t" || { say "install $t"; pkg_install "$t"; }; done

if ! have gh; then
  say "install GitHub CLI"
  case "$PM" in
    brew)   pkg_install gh ;;
    pacman) pkg_install github-cli ;;
    apt)
      # Official GitHub CLI apt repository (Ubuntu's own package is outdated).
      $SUDO mkdir -p -m 755 /etc/apt/keyrings
      curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | $SUDO tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
      $SUDO chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        | $SUDO tee /etc/apt/sources.list.d/github-cli.list >/dev/null
      $SUDO apt-get update -y && pkg_install gh ;;
  esac
fi

if ! node_ok; then
  say "install Node.js (>= 22.19)"
  case "$PM" in
    brew)   pkg_install node ;;
    pacman) pkg_install nodejs npm ;;
    apt)
      # NodeSource LTS: Ubuntu's nodejs package is too old for Pi.
      curl -fsSL https://deb.nodesource.com/setup_lts.x | ${SUDO:+$SUDO -E} bash -
      pkg_install nodejs ;;
  esac
  node_ok || die "Node.js >= 22.19 still not available on PATH"
fi

# ---------------------------------------------------------------- tools
if ! have pi; then
  say "install Pi (official installer)"
  curl -fsSL https://pi.dev/install.sh | sh
  export PATH="$HOME/.pi/agent/bin:$HOME/.local/bin:$PATH"
  have pi || die "pi not on PATH after install — open a new shell and re-run"
fi

if ! have herdr; then
  say "install herdr"
  if [ "$PM" = "brew" ]; then brew install herdr; else curl -fsSL https://herdr.dev/install.sh | sh; fi
fi

if ! have tsk; then
  say "install tsk"
  if [ "$PM" = "brew" ]; then brew install smarzban/tap/tsk; else curl -fsSL https://gettsk.sh/install.sh | sh; fi
fi

if ! have codebase-memory-mcp; then
  say "install codebase-memory-mcp"
  curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
fi

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) warn "add ~/.local/bin to PATH in your shell profile (pr-gate, codebase-memory-mcp live there)" ;;
esac

[ "$MODE" = "tools" ] && { say "tools done"; exit 0; }

# ---------------------------------------------------------------- apply
if ! gh auth status >/dev/null 2>&1; then
  warn "gh is not logged in — secrets cannot be pulled from the private repo."
  if [ -t 0 ]; then gh auth login; else warn "run: gh auth login && node scripts/setup.mjs apply"; fi
fi

say "apply Pi setup"
node "$REPO_DIR/scripts/setup.mjs" apply
