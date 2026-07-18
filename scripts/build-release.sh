#!/usr/bin/env bash
# Build, sign, and package Markora for distribution.
# Usage: ./scripts/build-release.sh [--notarize] [--skip-build]
set -euo pipefail

# -------- Configuration --------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_NAME="Markora"
SIGN_IDENTITY="Developer ID Application: Guofeng Liu (U8U443D7ZL)"
NOTARY_PROFILE="Markora"

# Read version from tauri.conf.json (single source of truth)
TAURI_CONF="${PROJECT_ROOT}/src-tauri/tauri.conf.json"
if [[ ! -f "${TAURI_CONF}" ]]; then
  echo "❌ tauri.conf.json not found at ${TAURI_CONF}" >&2
  exit 1
fi
VERSION="$(/usr/bin/python3 -c "import json;print(json.load(open('${TAURI_CONF}'))['version'])" 2>/dev/null || true)"
if [[ -z "${VERSION}" ]]; then
  echo "❌ Could not read version from tauri.conf.json" >&2
  exit 1
fi

APP_PATH="${PROJECT_ROOT}/src-tauri/target/release/bundle/macos/${APP_NAME}.app"
DMG_DIR="${PROJECT_ROOT}/src-tauri/target/release/bundle/dmg"
DMG_PATH="${DMG_DIR}/${APP_NAME}_${VERSION}_aarch64.dmg"

# -------- Flags --------
DO_NOTARIZE=0
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --notarize) DO_NOTARIZE=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help)
      cat <<EOF
Build & sign Markora for distribution.

Usage: $(basename "$0") [--notarize] [--skip-build]

Options:
  --notarize     Also submit to Apple notarization and staple the ticket
                 (requires notarytool network access; may fail inside sandboxes)
  --skip-build   Skip the Tauri build step (reuse existing bundle)
  -h, --help     Show this help

Steps performed:
  1. Build the app with Tauri (unless --skip-build)
  2. Re-sign the .app with Developer ID + --timestamp (fixes Tauri default)
  3. Create an HFS+ UDZO .dmg (APFS breaks codesign hashes on macOS 26)
  4. Re-sign the .dmg
  5. Verify both signatures
  6. If --notarize: submit, wait, staple, verify Gatekeeper
     Else: print manual notarization commands
EOF
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

cd "${PROJECT_ROOT}"

# -------- Helpers --------
log() { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
err() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }

require() {
  command -v "$1" >/dev/null 2>&1 || { err "Missing required tool: $1"; exit 1; }
}

require codesign
require hdiutil
require spctl
require xcrun

sign_app() {
  log "Codesigning ${APP_NAME}.app with Developer ID (+ timestamp)"
  # Tauri's default codesign omits --timestamp, which causes codesign --verify
  # to later complain about an invalid signature. Re-sign with --timestamp.
  codesign --force --deep --options runtime --timestamp \
    --sign "${SIGN_IDENTITY}" \
    "${APP_PATH}"
  ok "Signed ${APP_NAME}.app"
}

verify_app() {
  log "Verifying .app signature"
  if codesign --verify --deep --strict --verbose=2 "${APP_PATH}"; then
    ok "App signature OK"
  else
    err "App signature verification failed"
    exit 1
  fi
}

create_dmg() {
  log "Creating HFS+ UDZO .dmg at ${DMG_PATH}"
  mkdir -p "${DMG_DIR}"
  # Remove stale dmg so hdiutil doesn't error out on existing -ov
  [[ -f "${DMG_PATH}" ]] && rm -f "${DMG_PATH}"
  # Build a DMG root containing both the app and an Applications symlink,
  # so users get the classic drag-to-Applications install layout.
  local dmg_root
  dmg_root="$(mktemp -d)"
  cp -RPp "${APP_PATH}" "${dmg_root}/"
  ln -s /Applications "${dmg_root}/Applications"
  # macOS 26 (Tahoe) defaults to APFS; APFS breaks code signature hashes inside DMG.
  # Force HFS+ with UDZO compression for a notarization-friendly DMG.
  hdiutil create \
    -volname "${APP_NAME}" \
    -srcfolder "${dmg_root}" \
    -ov \
    -format UDZO \
    -fs HFS+ \
    "${DMG_PATH}"
  rm -rf "${dmg_root}"
  ok "DMG created"
}

sign_dmg() {
  log "Codesigning the .dmg"
  codesign --force --sign "${SIGN_IDENTITY}" --timestamp "${DMG_PATH}"
  ok "Signed DMG"
}

verify_dmg() {
  log "Verifying DMG signature"
  if codesign --verify --verbose=2 "${DMG_PATH}"; then
    ok "DMG signature OK"
  else
    err "DMG signature verification failed"
    exit 1
  fi
}

print_manual_notarize() {
  cat <<EOF

────────────────────────────────────────────────────────────────────
✅ Build & sign complete. Now run NOTARIZATION + STAPLE manually:

xcrun notarytool submit "${DMG_PATH}" \\
  --keychain-profile "${NOTARY_PROFILE}" --wait

xcrun stapler staple "${DMG_PATH}"
xcrun stapler staple "${APP_PATH}"

# Final Gatekeeper verification:
spctl -a -vvv -t open \\
  --context context:primary-signature "${DMG_PATH}"
spctl -a -vvv -t exec "${APP_PATH}"

# Or re-run this script with --notarize to do it automatically
# (only works outside restricted sandboxes).
────────────────────────────────────────────────────────────────────

EOF
}

do_notarize_and_staple() {
  log "Submitting ${DMG_PATH} to Apple notarization"
  if ! xcrun notarytool submit "${DMG_PATH}" \
        --keychain-profile "${NOTARY_PROFILE}" --wait; then
    err "Notarization submission failed"
    err "If running inside a restricted sandbox, run without --notarize"
    err "and invoke notarytool manually in your terminal."
    exit 1
  fi
  ok "Notarization accepted"

  log "Stapling notarization ticket to .dmg"
  xcrun stapler staple "${DMG_PATH}"
  ok "Staple .dmg"

  log "Stapling notarization ticket to .app"
  xcrun stapler staple "${APP_PATH}"
  ok "Staple .app"
}

final_verify() {
  log "Gatekeeper check on .dmg"
  spctl -a -vvv -t open --context context:primary-signature "${DMG_PATH}" || {
    err "Gatekeeper rejected the DMG"
    exit 1
  }
  log "Gatekeeper check on .app"
  spctl -a -vvv -t exec "${APP_PATH}" || {
    err "Gatekeeper rejected the App"
    exit 1
  }
  ok "Gatekeeper: both accepted"
}

# -------- Main flow --------
if [[ "${SKIP_BUILD}" -eq 0 ]]; then
  log "Building Markora ${VERSION} with Tauri"
  npm run desktop:build
  ok "Build complete"
else
  log "Skipping build (--skip-build)"
  if [[ ! -d "${APP_PATH}" ]]; then
    err "No existing app bundle at ${APP_PATH}. Run without --skip-build first."
    exit 1
  fi
fi

if [[ ! -d "${APP_PATH}" ]]; then
  err "App bundle not found after build: ${APP_PATH}"
  err "Check Tauri build output above."
  exit 1
fi

sign_app
verify_app
create_dmg
sign_dmg
verify_dmg

echo
ok "Release artifacts ready:"
echo "  App:  ${APP_PATH}"
echo "  DMG:  ${DMG_PATH}"
echo

if [[ "${DO_NOTARIZE}" -eq 1 ]]; then
  do_notarize_and_staple
  final_verify
  ok "🎉 Markora ${VERSION} is notarized & stapled. Ready to distribute."
else
  print_manual_notarize
fi
