#!/bin/bash
# Stores everything the release workflow needs as GitHub Actions secrets on this repo, from a .p12
# you exported from Keychain Access. The .p12 is checked to really hold a Developer ID Application
# identity before anything is uploaded.
#
# Why not export it here: on current macOS the Developer ID key often lives in the data-protection
# keychain ("Local Items" / iCloud), which `security export` cannot reach. It silently exports
# whatever else the login keychain holds instead, and CI then signs with the wrong identity.
#
# Export it first: Keychain Access → My Certificates → right-click
# "Developer ID Application: …" → Export… → save as .p12 with a password.
#
# Values come from .env (see .env.example); anything missing is prompted for.
#
# Usage: scripts/setup-signing-secrets.sh path/to/certificate.p12 [owner/repo]

set -euo pipefail

P12="${1:-}"
[ -f "$P12" ] || {
  echo "Usage: $0 path/to/certificate.p12 [owner/repo]" >&2
  echo "Export it from Keychain Access → My Certificates → Developer ID Application → Export…" >&2
  exit 1
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

command -v gh >/dev/null || { echo "gh is required: brew install gh" >&2; exit 1; }

REPO="${2:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"

[ -n "${APPLE_ID:-}" ] || read -r -p "Apple ID email: " APPLE_ID
[ -n "${APPLE_TEAM_ID:-}" ] || read -r -p "Apple team id: " APPLE_TEAM_ID
[ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] ||
  { read -r -s -p "App-specific password: " APPLE_APP_SPECIFIC_PASSWORD; echo; }
[ -n "${CSC_KEY_PASSWORD:-}" ] ||
  { read -r -s -p "Password you gave the .p12 when exporting it: " CSC_KEY_PASSWORD; echo; }

# Import into a throwaway keychain to prove the .p12 opens with that password and holds a valid
# Developer ID Application identity for this team — the same check CI makes before signing.
WORK="$(mktemp -d)"
CHECK="$WORK/check.keychain-db"
cleanup() {
  security delete-keychain "$CHECK" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
security create-keychain -p check "$CHECK"
security import "$P12" -k "$CHECK" -P "$CSC_KEY_PASSWORD" >/dev/null ||
  { echo "Could not open $P12 with that password" >&2; exit 1; }
IDENTITY="$(security find-identity -p codesigning "$CHECK" |
  sed -n "s/.*\"\(Developer ID Application: .*($APPLE_TEAM_ID)\)\".*/\1/p" | head -1)"
if [ -z "$IDENTITY" ]; then
  echo "$P12 has no Developer ID Application identity for team $APPLE_TEAM_ID. It contains:" >&2
  security find-identity -p codesigning "$CHECK" >&2
  exit 1
fi

echo "Setting signing secrets on $REPO using: $IDENTITY"
base64 -i "$P12" | gh secret set CSC_LINK --repo "$REPO"
printf '%s' "$CSC_KEY_PASSWORD" | gh secret set CSC_KEY_PASSWORD --repo "$REPO"
printf '%s' "$APPLE_ID" | gh secret set APPLE_ID --repo "$REPO"
printf '%s' "$APPLE_APP_SPECIFIC_PASSWORD" | gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo "$REPO"
printf '%s' "$APPLE_TEAM_ID" | gh secret set APPLE_TEAM_ID --repo "$REPO"

echo
gh secret list --repo "$REPO"
echo
echo "Delete the exported .p12 now that it is stored: rm '$P12'"
