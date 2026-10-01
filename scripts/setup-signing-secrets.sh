#!/bin/bash
# Exports the Developer ID Application certificate from the login keychain and stores everything
# the release workflow needs as GitHub Actions secrets on this repo. Nothing is copied to the
# clipboard or left on disk: the .p12 lives in a temp directory removed on exit.
#
# Values come from .env (see .env.example); anything missing is prompted for.
#
# Usage: scripts/setup-signing-secrets.sh [owner/repo]   (defaults to this checkout's GitHub repo)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

command -v gh >/dev/null || { echo "gh is required: brew install gh" >&2; exit 1; }

REPO="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"

[ -n "${APPLE_ID:-}" ] || read -r -p "Apple ID email: " APPLE_ID
[ -n "${APPLE_TEAM_ID:-}" ] || read -r -p "Apple team id: " APPLE_TEAM_ID
[ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] ||
  { read -r -s -p "App-specific password: " APPLE_APP_SPECIFIC_PASSWORD; echo; }

# CSC_NAME may be given with or without the "Developer ID Application: " prefix. Without it, use
# whichever Developer ID Application identity in the keychain belongs to the team.
IDENTITY="${CSC_NAME:-}"
IDENTITY="${IDENTITY#Developer ID Application: }"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning |
    sed -n "s/.*\"Developer ID Application: \(.*($APPLE_TEAM_ID)\)\"/\1/p" | head -1)"
fi
if [ -z "$IDENTITY" ] ||
  ! security find-identity -v -p codesigning | grep -qF "Developer ID Application: $IDENTITY"; then
  echo "No Developer ID Application certificate for team $APPLE_TEAM_ID in the keychain" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
P12="$WORK/certificate.p12"

echo "Setting signing secrets on $REPO using: Developer ID Application: $IDENTITY"
echo
if [ -z "${CSC_KEY_PASSWORD:-}" ]; then
  read -r -s -p "New password to protect the exported .p12: " CSC_KEY_PASSWORD; echo
  read -r -s -p "Confirm: " CONFIRM; echo
  [ "$CSC_KEY_PASSWORD" = "$CONFIRM" ] || { echo "Passwords don't match" >&2; exit 1; }
fi

# Exports every identity in the login keychain; electron-builder picks the Developer ID one.
# macOS asks for your login password to allow the export.
security export -k ~/Library/Keychains/login.keychain-db -t identities -f pkcs12 \
  -P "$CSC_KEY_PASSWORD" -o "$P12"

base64 -i "$P12" | gh secret set CSC_LINK --repo "$REPO"
printf '%s' "$CSC_KEY_PASSWORD" | gh secret set CSC_KEY_PASSWORD --repo "$REPO"
printf '%s' "$APPLE_ID" | gh secret set APPLE_ID --repo "$REPO"
printf '%s' "$APPLE_APP_SPECIFIC_PASSWORD" | gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo "$REPO"
printf '%s' "$APPLE_TEAM_ID" | gh secret set APPLE_TEAM_ID --repo "$REPO"

echo
gh secret list --repo "$REPO"
