#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SPEC_SRC="$SKILL_DIR/resources/autocerto.json"
API_ANYTHING_HOME="${API_ANYTHING_HOME:-$HOME/.api-anything}"

echo "==> AutoCerto + api-anything installer"

# 1. Android / Termux OpenSSL fix if PREFIX/etc/tls/openssl.cnf exists
if [ -n "${PREFIX:-}" ] && [ -f "$PREFIX/etc/tls/openssl.cnf" ]; then
  export OPENSSL_CONF="${OPENSSL_CONF:-$PREFIX/etc/tls/openssl.cnf}"
  if [ -d "$PREFIX/etc/profile.d" ] && [ ! -f "$PREFIX/etc/profile.d/openssl.sh" ]; then
    printf 'export OPENSSL_CONF="${PREFIX:-%s}/etc/tls/openssl.cnf"\n' "$PREFIX" > "$PREFIX/etc/profile.d/openssl.sh" || true
  fi
fi

# 2. Check Node.js >= 22.13.0
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js (>= 22.13.0) is required."
  if command -v pkg >/dev/null 2>&1; then
    echo "On Termux/Android, run: pkg update && pkg install nodejs npm"
  else
    echo "Install Node.js 22.13+ from https://nodejs.org/ or via nvm/fnm."
  fi
  exit 1
fi

NODE_VER="$(node -v | sed 's/^v//')"
NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
NODE_MINOR="$(echo "$NODE_VER" | cut -d. -f2)"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  echo "ERROR: Node.js v$NODE_VER found, but api-anything requires >= 22.13.0."
  exit 1
fi
echo "OK: Node.js v$NODE_VER"

# 3. Install api-anything globally if missing
if ! command -v api-anything >/dev/null 2>&1; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "ERROR: npm is required to install api-anything."
    exit 1
  fi
  echo "==> Installing api-anything globally..."
  npm install -g api-anything
fi

# 4. On Android/Termux environments, fix shebangs and wrap api-anything with OPENSSL_CONF
if [ -n "${PREFIX:-}" ] && [ -f "$PREFIX/etc/tls/openssl.cnf" ]; then
  if command -v agy-fix-paths >/dev/null 2>&1 && [ -d "$PREFIX/lib/node_modules/api-anything" ]; then
    agy-fix-paths "$PREFIX/lib/node_modules/api-anything" >/dev/null 2>&1 || true
  fi
  BIN_PATH="$PREFIX/bin/api-anything"
  CLI_JS="$PREFIX/lib/node_modules/api-anything/dist/cli.js"
  if [ -f "$CLI_JS" ] && [ -L "$BIN_PATH" ]; then
    rm -f "$BIN_PATH"
    cat > "$BIN_PATH" <<EOF
#!$PREFIX/bin/bash
export OPENSSL_CONF="\${OPENSSL_CONF:-$PREFIX/etc/tls/openssl.cnf}"
exec "$PREFIX/bin/node" "$CLI_JS" "\$@"
EOF
    chmod +x "$BIN_PATH"
    echo "OK: Wrapped $BIN_PATH with OPENSSL_CONF"
  fi
fi

echo "OK: api-anything $(api-anything --version)"

# 5. Install AutoCerto site spec
mkdir -p "$API_ANYTHING_HOME/sites"
cp "$SPEC_SRC" "$API_ANYTHING_HOME/sites/autocerto.json"
chmod 600 "$API_ANYTHING_HOME/sites/autocerto.json"
echo "OK: Installed site spec -> $API_ANYTHING_HOME/sites/autocerto.json"

# 6. Validate spec loads cleanly
api-anything ops autocerto >/dev/null
echo "OK: Validated autocerto spec (8 read-only operations ready)"

echo ""
echo "Next steps:"
echo "  1. Export cookies from https://sistema.autocerto.com (signed in) to a local file."
echo "  2. Import session:"
echo "       api-anything login autocerto --cookies /path/to/autocerto-cookies.json"
echo "  3. Test:"
echo "       api-anything call autocerto leadCounters"
echo "       api-anything call autocerto searchStockJson query="
echo "  4. Connect MCP to your agent (optional):"
echo "       npx -y api-anything setup --no-share"
