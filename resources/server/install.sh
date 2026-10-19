#!/bin/sh
# Installs and starts the Styr server (`styr serve`) on a Linux machine, for remote workspaces.
# See docs/architecture/remote.md in https://github.com/anoguez/styr.
#
# By hand, or from cloud-init (each release publishes this file with its version filled in):
#
#   curl -fsSL https://github.com/anoguez/styr/releases/latest/download/install.sh | sh
#
# The desktop app runs this same script over ssh (`ssh host sh -s -- --install …`), so a server set
# up either way has the same layout and unit, and either can upgrade what the other installed:
#
#   ~/.styr/server/<version>/       one unpacked bundle per version, side by side
#   ~/.styr/server/current          a symlink to the version that starts next
#   ~/.config/systemd/user/styr-server.service
#
# Modes (the default is --install):
#   --probe     print what the desktop app checks: OS, arch, git, the agent CLI, systemd, linger,
#               the installed and the running version. Changes nothing.
#   --install   download (or take --tarball), verify, unpack beside any other version, point
#               `current` at it, and start the server unless one is already running. A running
#               server is never restarted: the new version takes over on the next restart.
#   --start     start the installed server unless it is running.
#   --restart   restart it now (stops its agents).
#   --stop      stop it (stops its agents).
#
# Options: --version <v>; --sha256 <hex>, the hash the bundle must have (the desktop app passes the
# one built into the signed app; without it the release's SHA256SUMS is used, which only catches a
# corrupt download); --tarball <file>, a bundle the desktop app uploaded instead of downloading;
# --cli <name> (the agent CLI --probe looks for), --pid <pid> (the server to stop when no systemd
# unit runs it).
#
# Lines starting with `::styr ` are for the desktop app; everything else is for people.
# Exit codes: 10 not Linux, 11 unsupported arch, 20 the download failed and 22 the bundle did not
# match its SHA-256 (the desktop app then uploads a copy it checked itself), 21 the bundle is
# broken, 30 the server did not start, 31 it did not stop, 64 bad arguments.

set -eu

STYR_VERSION="${STYR_VERSION:-@STYR_VERSION@}"
STYR_REPO="${STYR_REPO:-anoguez/styr}"
UNIT=styr-server.service

mode=install
tarball=""
sha256=""
cli=""
pid=""

fail() {
  code="$1"
  shift
  printf 'styr: %s\n' "$*" >&2
  exit "$code"
}

report() { printf '::styr %s=%s\n' "$1" "$2"; }
say() { printf '%s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --probe | --install | --start | --restart | --stop) mode="${1#--}" ;;
    --version) STYR_VERSION="${2:-}" && shift ;;
    --tarball) tarball="${2:-}" && shift ;;
    --sha256) sha256="${2:-}" && shift ;;
    --cli) cli="${2:-}" && shift ;;
    --pid) pid="${2:-}" && shift ;;
    -h | --help)
      printf 'See the comments at the top of install.sh, or docs/architecture/remote.md.\n'
      exit 0
      ;;
    *) fail 64 "unknown argument: $1" ;;
  esac
  shift
done

case "$STYR_VERSION" in
  '' | *[!0-9A-Za-z.+-]*)
    [ "$mode" != install ] || fail 64 "give the version to install: --version <v>"
    STYR_VERSION=""
    ;;
esac
case "$cli" in *[!0-9A-Za-z._-]*) cli="" ;; esac
case "$pid" in *[!0-9]*) pid="" ;; esac
case "$sha256" in *[!0-9a-f]*) fail 64 "--sha256 takes a lowercase hex SHA-256" ;; esac
# A relative --tarball is from here: the home folder when the desktop app runs this over ssh.
case "$tarball" in '' | /*) ;; *) tarball="$(pwd)/$tarball" ;; esac

base="$HOME/.styr/server"
socket="$HOME/.styr/server.sock"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
user="$(id -un)"
# A non-interactive ssh session may not carry it, and `systemctl --user` needs it.
[ -n "${XDG_RUNTIME_DIR:-}" ] || XDG_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR

os="$(uname -s)"
machine="$(uname -m)"
case "$machine" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) arch="" ;;
esac

# What a login shell finds, which is what an agent started by the server will find: ssh runs this
# script without the profile, where ~/.local/bin (claude's usual home) is often missing from PATH.
login_path() { "${SHELL:-/bin/sh}" -lc 'printf "\n%s" "$PATH"' </dev/null 2>/dev/null | tail -n 1; }
has_command() { "${SHELL:-/bin/sh}" -lc "command -v $1" </dev/null >/dev/null 2>&1; }

has_systemd() { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; }

linger() {
  value="$(loginctl show-user "$user" --property=Linger 2>/dev/null | sed -n 's/^Linger=//p')"
  if [ -z "$value" ] && [ -e "/var/lib/systemd/linger/$user" ]; then value=yes; fi
  printf '%s' "${value:-no}"
}

# The installed `styr serve attach` exits 0 when a server answers on the socket, 2 when none does.
alive() { [ -x "$base/current/bin/styr" ] && "$base/current/bin/styr" serve attach </dev/null >/dev/null 2>&1; }

running_version() {
  [ -x "$base/current/bin/styr" ] || return 0
  "$base/current/bin/styr" serve attach </dev/null 2>/dev/null | head -c 4096 |
    sed -n 's/.*"server:hello".*"version":"\([^"]*\)".*/\1/p' | head -n 1
}

wait_until() {
  i=0
  while [ "$i" -lt 75 ]; do
    if [ "$1" = up ]; then alive && return 0; else alive || return 0; fi
    sleep 0.2
    i=$((i + 1))
  done
  return 1
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    printf 'styr: neither curl nor wget is installed\n' >&2
    return 1
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    return 1
  fi
}

probe() {
  report os "$os"
  report machine "$machine"
  report arch "$arch"
  if command -v git >/dev/null 2>&1 || has_command git; then report git yes; else report git no; fi
  if [ -n "$cli" ]; then
    if has_command "$cli"; then report cli yes; else report cli no; fi
  fi
  if has_systemd; then report systemd yes; else report systemd no; fi
  report linger "$(linger)"
  if [ -x "$base/current/bin/styr" ]; then
    report installed "$("$base/current/bin/styr" serve --version 2>/dev/null || true)"
  fi
  if [ -n "$STYR_VERSION" ] && [ -x "$base/$STYR_VERSION/bin/styr" ]; then report has_version yes; fi
  if alive; then report running "$(running_version)"; fi
}

require_platform() {
  [ "$os" = Linux ] || fail 10 "this machine runs $os; the Styr server runs on Linux only"
  [ -n "$arch" ] || fail 11 "this machine is $machine; the Styr server is built for x86_64 and aarch64"
}

workdir=""
cleanup() { [ -z "$workdir" ] || rm -rf "$workdir"; }
trap cleanup EXIT

install_bundle() {
  dir="$base/$STYR_VERSION"
  if [ -x "$dir/bin/styr" ] && [ "$("$dir/bin/styr" serve --version 2>/dev/null || true)" = "$STYR_VERSION" ]; then
    say "Styr server $STYR_VERSION is already installed in $dir."
    report source installed
    [ -z "$tarball" ] || rm -f "$tarball"
    return 0
  fi
  name="styr-server-$STYR_VERSION-linux-$arch.tar.gz"
  mkdir -p "$base"
  workdir="$(mktemp -d "$base/.install.XXXXXX")"
  if [ -n "$tarball" ]; then
    [ -n "$sha256" ] || fail 64 "--tarball needs --sha256"
    file="$tarball"
    source=upload
  else
    url="https://github.com/$STYR_REPO/releases/download/v$STYR_VERSION"
    say "Downloading $name from $url …"
    fetch "$url/$name" "$workdir/$name" || fail 20 "could not download $url/$name from this machine"
    if [ -z "$sha256" ]; then
      # By hand: the release's SHA256SUMS catches a corrupt download. The desktop app passes the
      # hash built into the signed app instead, and the README shows how to check the attestation.
      fetch "$url/styr-server-$STYR_VERSION-SHA256SUMS" "$workdir/SHA256SUMS" ||
        fail 20 "could not download the checksums from $url"
      sha256="$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$workdir/SHA256SUMS")"
      [ -n "$sha256" ] || fail 20 "the release lists no checksum for $name"
    fi
    file="$workdir/$name"
    source=download
  fi
  actual="$(sha256_of "$file")" || fail 20 "neither sha256sum nor shasum is installed, so the bundle cannot be checked"
  [ "$actual" = "$sha256" ] || fail 22 "$name does not match the expected SHA-256 (refused to unpack it)"
  mkdir "$workdir/unpack"
  tar -xzf "$file" -C "$workdir/unpack" || fail 21 "could not unpack $name"
  got="$("$workdir/unpack/bin/styr" serve --version 2>/dev/null || true)"
  [ "$got" = "$STYR_VERSION" ] || fail 21 "the unpacked bundle does not run here (it says: ${got:-nothing})"
  rm -rf "$dir"
  mv "$workdir/unpack" "$dir"
  [ -z "$tarball" ] || rm -f "$tarball"
  say "Installed Styr server $STYR_VERSION in $dir."
  report source "$source"
}

write_unit() {
  path="$(login_path)"
  [ -n "$path" ] || path="$PATH"
  escaped="$(printf '%s' "$path" | sed 's/%/%%/g; s/\\/\\\\/g; s/"/\\"/g')"
  mkdir -p "$unit_dir"
  cat >"$unit_dir/$UNIT" <<EOF
# Written by Styr (install.sh). Rewritten on every install; edit a drop-in instead.
[Unit]
Description=Styr server (styr serve)
Documentation=https://github.com/$STYR_REPO/blob/main/docs/architecture/remote.md

[Service]
Type=simple
ExecStart=%h/.styr/server/current/bin/styr serve
Environment="PATH=$escaped"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null 2>&1 || true
}

start_server() {
  [ -x "$base/current/bin/styr" ] || fail 30 "no Styr server is installed in $base"
  if has_systemd; then
    report systemd yes
    write_unit
    if alive; then
      say "A Styr server is already running; it keeps running."
    else
      systemctl --user start "$UNIT" || fail 30 "systemctl --user start $UNIT failed"
    fi
  else
    report systemd no
    if alive; then
      say "A Styr server is already running; it keeps running."
    else
      say "No systemd user session here: starting the server with nohup. It will not come back after a reboot."
      mkdir -p "$HOME/.styr"
      path="$(login_path)"
      PATH="${path:-$PATH}" nohup "$base/current/bin/styr" serve >>"$HOME/.styr/server.log" 2>&1 </dev/null &
    fi
  fi
  wait_until up ||
    fail 30 "the server did not start; see journalctl --user -u $UNIT or ~/.styr/server.log"
  report running "$(running_version)"
}

stop_server() {
  if has_systemd && systemctl --user is-active --quiet "$UNIT"; then
    systemctl --user stop "$UNIT"
  elif [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
  elif alive; then
    fail 31 "a Styr server is running outside systemd; give its --pid to stop it"
  fi
  wait_until down || fail 31 "the server is still running"
  say "Stopped the Styr server."
}

report_linger() {
  if has_systemd; then
    state="$(linger)"
    report linger "$state"
    if [ "$state" != yes ]; then
      say ''
      say 'Lingering is off, so the server stops when your last session on this machine ends.'
      say 'To keep it running while you are logged out, run this once (it needs sudo):'
      say ''
      # shellcheck disable=SC2016 # printed for the reader to run, not expanded here
      say '  sudo loginctl enable-linger $USER'
    fi
  fi
}

case "$mode" in
  probe) probe ;;
  install)
    require_platform
    install_bundle
    ln -sfn "$STYR_VERSION" "$base/current"
    start_server
    report_linger
    ;;
  start)
    require_platform
    start_server
    report_linger
    ;;
  restart)
    require_platform
    stop_server
    start_server
    report_linger
    ;;
  stop) stop_server ;;
esac
