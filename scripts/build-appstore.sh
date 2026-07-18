#!/usr/bin/env bash
# Build Markora for Apple App Store (sandboxed .app -> .pkg -> upload).
#
# Prerequisites:
#   1. "Apple Distribution" certificate (signs the .app) — create at
#      https://developer.apple.com/account/resources/certificates/add
#   2. "3rd Party Mac Developer Installer" certificate (signs the .pkg)
#   3. App Store Connect app record + API key (or app-specific password)
#
# Usage:
#   ./scripts/build-appstore.sh                          # build + sign + pkg
#   ./scripts/build-appstore.sh --identity "Apple Distribution: Your Name (TEAMID)"
#   ./scripts/build-appstore.sh --upload                 # also upload to App Store Connect
#   ./scripts/build-appstore.sh --skip-build             # reuse existing .app
set -euo pipefail

# -------- Configuration --------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_NAME="Markora"
ENTITLEMENTS="${PROJECT_ROOT}/src-tauri/entitlements.plist"

# Default signing identities — override with --identity or env vars
APP_IDENTITY="${APPSTORE_APP_IDENTITY:-}"
INSTALLER_IDENTITY="${APPSTORE_INSTALLER_IDENTITY:-}"

# App Store Connect API (for --upload)
API_KEY_ID="${APPSTORE_API_KEY_ID:-}"
API_ISSUER_ID="${APPSTORE_API_ISSUER_ID:-}"

# Read version
TAURI_CONF="${PROJECT_ROOT}/src-tauri/tauri.conf.json"
VERSION="$(/usr/bin/python3 -c "import json;print(json.load(open('${TAURI_CONF}'))['version'])" 2>/dev/null || true)"
if [[ -z "${VERSION}" ]]; then
  echo "❌ Could not read version from tauri.conf.json" >&2
  exit 1
fi

APP_PATH="${PROJECT_ROOT}/src-tauri/target/release/bundle/macos/${APP_NAME}.app"
PKG_PATH="${PROJECT_ROOT}/src-tauri/target/release/bundle/pkg/${APP_NAME}_${VERSION}.pkg"

# -------- Flags --------
DO_UPLOAD=0
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --identity) shift; APP_IDENTITY="$1" ;;
    --installer-identity) shift; INSTALLER_IDENTITY="$1" ;;
    --upload) DO_UPLOAD=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help)
      cat <<EOF
Build Markora for Apple App Store.

Usage: $(basename "$0") [options]

Options:
  --identity <name>        App signing identity (default: env APPSTORE_APP_IDENTITY)
  --installer-identity <n> Pkg installer identity (default: env APPSTORE_INSTALLER_IDENTITY)
  --upload                 Upload .pkg to App Store Connect (needs API key)
  --skip-build             Reuse existing .app bundle
  -h, --help               Show this help

Environment:
  APPSTORE_APP_IDENTITY       Apple Distribution cert name
  APPSTORE_INSTALLER_IDENTITY 3rd Party Mac Developer Installer cert name
  APPSTORE_API_KEY_ID         App Store Connect API key ID
  APPSTORE_API_ISSUER_ID      App Store Connect issuer ID

Prerequisites:
  - Apple Distribution certificate (for .app signing)
  - 3rd Party Mac Developer Installer certificate (for .pkg signing)
  - App Store Connect app record
  - For --upload: API key in ~/.appstoreconnect/private_keys/
EOF
      exit 0 ;;
    *) ;;
  esac
done

cd "${PROJECT_ROOT}"

# -------- Helpers --------
log() { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
err() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }

# -------- Build --------
if [[ "${SKIP_BUILD}" -eq 0 ]]; then
  log "Building Markora ${VERSION} with Tauri (sandbox entitlements)"
  APPLE_SIGNING_IDENTITY="${APP_IDENTITY}" npm run desktop:build
  ok "Build complete"
else
  log "Skipping build (--skip-build)"
  if [[ ! -d "${APP_PATH}" ]]; then
    err "No existing app bundle at ${APP_PATH}"
    exit 1
  fi
fi

# -------- Sign .app with Apple Distribution --------
if [[ -z "${APP_IDENTITY}" ]]; then
  err "No app signing identity specified."
  err "Create an 'Apple Distribution' certificate at:"
  err "  https://developer.apple.com/account/resources/certificates/add"
  err "Then run:"
  err "  ./scripts/build-appstore.sh --identity 'Apple Distribution: Your Name (TEAMID)'"
  err ""
  err "Available signing identities:"
  security find-identity -v -p codesigning 2>&1 | sed 's/^/  /'
  exit 1
fi

log "Re-signing .app with ${APP_IDENTITY} + entitlements"
codesign --force --deep --options runtime \
  --entitlements "${ENTITLEMENTS}" \
  --sign "${APP_IDENTITY}" \
  "${APP_PATH}"

log "Verifying .app signature"
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"
ok "App signed"

# -------- Build .pkg with productbuild --------
if [[ -z "${INSTALLER_IDENTITY}" ]]; then
  err "No installer signing identity specified."
  err "Create a '3rd Party Mac Developer Installer' certificate at:"
  err "  https://developer.apple.com/account/resources/certificates/add"
  err "Then run:"
  err "  ./scripts/build-appstore.sh --installer-identity '3rd Party Mac Developer Installer: ...'"
  err ""
  err "Available installer identities:"
  security find-identity -v -p installer 2>&1 | sed 's/^/  /'
  exit 1
fi

log "Building .pkg with productbuild"
mkdir -p "$(dirname "${PKG_PATH}")"
[[ -f "${PKG_PATH}" ]] && rm -f "${PKG_PATH}"
productbuild \
  --component "${APP_PATH}" /Applications \
  --sign "${INSTALLER_IDENTITY}" \
  "${PKG_PATH}"
ok "PKG created: ${PKG_PATH}"

# -------- Upload --------
if [[ "${DO_UPLOAD}" -eq 1 ]]; then
  if [[ -z "${API_KEY_ID}" || -z "${API_ISSUER_ID}" ]]; then
    err "App Store Connect API key not configured."
    err "Set APPSTORE_API_KEY_ID and APPSTORE_API_ISSUER_ID env vars."
    err "Create an API key at:"
    err "  https://appstoreconnect.apple.com/access/integrations/api"
    err "Save the private key to ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8"
    exit 1
  fi

  log "Uploading ${PKG_PATH} to App Store Connect"
  xcrun altool \
    --upload-app \
    --type osx \
    --file "${PKG_PATH}" \
    --apiKey "${API_KEY_ID}" \
    --apiIssuer "${API_ISSUER_ID}" \
    --verbose
  ok "Upload complete"
else
  cat <<EOF

────────────────────────────────────────────────────────────────────
✅ Build complete. PKG ready at:
   ${PKG_PATH}

To upload to App Store Connect:

  # Option A: API key (recommended for automation)
  APPSTORE_API_KEY_ID=XXX APPSTORE_API_ISSUER_ID=XXX \
    ./scripts/build-appstore.sh --upload

  # Option B: Transporter app
  open -a Transporter "${PKG_PATH}"

  # Option C: Xcode Organizer
  # Xcode > Window > Organizer > Distribute App > App Store Connect
────────────────────────────────────────────────────────────────────

EOF
fi
