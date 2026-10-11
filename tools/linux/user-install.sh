#!/usr/bin/env bash
# OpenToon Studio — per-user Linux install, update and rollback. Never needs root.
#
#   tools/linux/user-install.sh install [BUILD_DIR]   install dist/linux-unpacked (default)
#   tools/linux/user-install.sh status                show installed versions
#   tools/linux/user-install.sh check [--json]        is a newer release out? (read-only)
#   tools/linux/user-install.sh update [--approve VERSION] [--to TAG] [--skip-gui-test]
#                                                     build + test + install a release, only
#                                                     after explicit approval of its version
#   tools/linux/user-install.sh rollback              switch back to the previous version
#   tools/linux/user-install.sh uninstall             remove the app (keeps your projects/settings)
#
# Layout (PREFIX defaults to ~/.local; override with OPENTOON_PREFIX):
#   $PREFIX/opt/opentoon-studio/versions/<version>-<commit>/   unpacked app + INSTALL-INFO.json
#   $PREFIX/opt/opentoon-studio/{current,previous}             symlinks into versions/
#   $PREFIX/bin/opentoon-studio                                launcher (Wayland by default)
#   $PREFIX/bin/opentoon-studio-update                         runs this script
#   $XDG_DATA_HOME/applications/opentoon-studio.desktop, icons, .otoon MIME type
#
# check exit codes (same as tools/check-update.cjs): 0 up to date, 10 update
# available, 2 network failure, 3 rate limited, 4 bad release data.
set -euo pipefail

APP_ID=opentoon-studio
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PREFIX="${OPENTOON_PREFIX:-$HOME/.local}"
OPT="$PREFIX/opt/$APP_ID"
BIN="$PREFIX/bin"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
KEEP_VERSIONS=3
ICON_SIZES="16 24 32 48 64 128 256 512"

die() { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*"; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not on PATH"; }

# version string from a packaged build's app.asar
build_version() {
  local asar="$1/resources/app.asar"
  [ -f "$asar" ] || die "not a packaged build (missing $asar)"
  node -e '
    const asar = require(process.argv[1]);
    process.stdout.write(JSON.parse(asar.extractFile(process.argv[2], "package.json")).version);
  ' "$REPO/node_modules/@electron/asar" "$asar" 2>/dev/null \
    || node -p 'require(process.argv[1]).version' "$REPO/package.json"
}

info_field() {   # info_field <INSTALL-INFO.json> <key>
  [ -f "$1" ] || return 0
  node -e 'const d = require(process.argv[1]); const v = d[process.argv[2]]; if (v != null) process.stdout.write(String(v));' "$1" "$2"
}

installed_info() { echo "$OPT/current/INSTALL-INFO.json"; }

refresh_desktop_caches() {
  command -v update-mime-database >/dev/null && update-mime-database "$DATA/mime" >/dev/null 2>&1 || true
  command -v update-desktop-database >/dev/null && update-desktop-database "$DATA/applications" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t -f "$DATA/icons/hicolor" >/dev/null 2>&1 || true
}

install_integration() {   # install_integration <source tree with assets/>
  local src="$1"
  mkdir -p "$BIN" "$DATA/applications" "$DATA/mime/packages"

  cat > "$BIN/$APP_ID" <<EOF
#!/bin/sh
# OpenToon Studio launcher (installed by tools/linux/user-install.sh).
# Native Wayland by default; OPENTOON_OZONE_PLATFORM=x11 forces XWayland.
case "\${OPENTOON_OZONE_PLATFORM:-auto}" in
  auto) set -- --ozone-platform-hint=auto "\$@" ;;
  *)    set -- --ozone-platform="\$OPENTOON_OZONE_PLATFORM" "\$@" ;;
esac
exec "$OPT/current/$APP_ID" "\$@"
EOF
  chmod 755 "$BIN/$APP_ID"

  cat > "$BIN/$APP_ID-update" <<EOF
#!/bin/sh
# OpenToon Studio update / rollback helper. See: $APP_ID-update help
exec "$REPO/tools/linux/user-install.sh" "\$@"
EOF
  chmod 755 "$BIN/$APP_ID-update"

  for s in $ICON_SIZES; do
    install -Dm644 "$src/assets/icons/${s}x${s}.png" "$DATA/icons/hicolor/${s}x${s}/apps/$APP_ID.png"
  done
  install -Dm644 "$src/assets/brand/opentoon-icon-master.svg" "$DATA/icons/hicolor/scalable/apps/$APP_ID.svg"
  install -Dm644 "$src/assets/brand/opentoon-file-icon.svg" \
    "$DATA/icons/hicolor/scalable/mimetypes/application-x-opentoon.svg"

  cat > "$DATA/mime/packages/$APP_ID.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/x-opentoon">
    <comment>OpenToon Project</comment>
    <sub-class-of type="application/json"/>
    <icon name="application-x-opentoon"/>
    <glob pattern="*.otoon"/>
  </mime-type>
</mime-info>
EOF

  cat > "$DATA/applications/$APP_ID.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=OpenToon Studio
GenericName=2D Animation Studio
Comment=Frame-by-frame 2D animation, inspired by Toon Boom Harmony
Exec="$BIN/$APP_ID" %F
TryExec=$BIN/$APP_ID
Icon=$APP_ID
Terminal=false
Categories=Graphics;2DGraphics;
MimeType=application/x-opentoon;
Keywords=animation;2d;cartoon;drawing;timeline;
StartupWMClass=$APP_ID
StartupNotify=true
EOF

  refresh_desktop_caches
  # claim .otoon only if nothing else has
  if command -v xdg-mime >/dev/null; then
    local cur; cur="$(xdg-mime query default application/x-opentoon 2>/dev/null || true)"
    [ -z "$cur" ] && xdg-mime default "$APP_ID.desktop" application/x-opentoon || true
  fi
}

prune_versions() {
  local keep_cur keep_prev
  keep_cur="$(readlink "$OPT/current" 2>/dev/null || true)"
  keep_prev="$(readlink "$OPT/previous" 2>/dev/null || true)"
  # newest first; always keep current + previous
  local n=0 d
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    n=$((n + 1))
    local rel; rel="versions/$(basename "$d")"
    if [ "$rel" = "$keep_cur" ] || [ "$rel" = "$keep_prev" ] || [ "$n" -le "$KEEP_VERSIONS" ]; then continue; fi
    info "removing old version $(basename "$d")"
    rm -rf -- "$d"
  done < <(ls -1dt "$OPT"/versions/*/ 2>/dev/null | sed 's:/$::')
}

# cmd_install <build dir> [source tree] [upstream tag] [port branch]
cmd_install() {
  need node
  local build="${1:-$REPO/dist/linux-unpacked}"
  local src="${2:-$REPO}"
  build="$(cd "$build" && pwd -P)" || die "build dir not found"
  [ -x "$build/$APP_ID" ] || die "$build/$APP_ID not found — run 'npm run dist:linux' first"

  local version commit describe dirty="" tag branch
  version="$(build_version "$build")"
  commit="$(git -C "$src" rev-parse --short=10 HEAD 2>/dev/null || echo unknown)"
  describe="$(git -C "$src" describe --tags --always 2>/dev/null || echo unknown)"
  if [ -n "$(git -C "$src" status --porcelain --untracked-files=no 2>/dev/null)" ]; then dirty="-dirty"; fi
  tag="${3:-$(git -C "$src" describe --tags --abbrev=0 2>/dev/null || echo "v$version")}"
  branch="${4:-$(git -C "$src" symbolic-ref --short -q HEAD 2>/dev/null || echo "")}"

  local id="$version-$commit$dirty"
  local dest="$OPT/versions/$id" stage="$OPT/versions/.stage-$id"
  mkdir -p "$OPT/versions"
  rm -rf -- "$stage"
  info "installing OpenToon Studio $version ($describe$dirty) to $dest"
  cp -a "$build/." "$stage/"
  node -e '
    const [file, version, commit, describe, dirty, tag, branch, repo, build] = process.argv.slice(1);
    require("fs").writeFileSync(file, JSON.stringify({
      version, commit, describe, dirty: dirty === "1", upstream_tag: tag, port_branch: branch || null,
      source_repo: repo, built_from: build, installed_at: new Date().toISOString()
    }, null, 2) + "\n");
  ' "$stage/INSTALL-INFO.json" "$version" "$commit" "$describe" "$([ -n "$dirty" ] && echo 1 || echo 0)" \
    "$tag" "$branch" "$REPO" "$build"

  local old_cur; old_cur="$(readlink "$OPT/current" 2>/dev/null || true)"
  if [ -d "$dest" ]; then rm -rf -- "$dest.old"; mv "$dest" "$dest.old"; fi
  mv "$stage" "$dest"
  rm -rf -- "$dest.old"
  if [ -n "$old_cur" ] && [ "$old_cur" != "versions/$id" ]; then ln -sfn "$old_cur" "$OPT/previous"; fi
  ln -sfn "versions/$id" "$OPT/current"

  install_integration "$src"
  prune_versions
  info "installed. Launch: $APP_ID  (or from your app launcher)"
  cmd_status
}

cmd_status() {
  local f; f="$(installed_info)"
  if [ ! -f "$f" ]; then echo "OpenToon Studio is not installed under $OPT"; return 1; fi
  echo "current : $(info_field "$f" version)  ($(info_field "$f" describe), installed $(info_field "$f" installed_at))"
  if [ -f "$OPT/previous/INSTALL-INFO.json" ]; then
    echo "previous: $(info_field "$OPT/previous/INSTALL-INFO.json" version)  ($(info_field "$OPT/previous/INSTALL-INFO.json" describe))  — '$APP_ID-update rollback' switches back"
  fi
  echo "app dir : $(readlink -f "$OPT/current")"
  echo "launcher: $BIN/$APP_ID"
  echo "desktop : $DATA/applications/$APP_ID.desktop"
  echo "settings: ${XDG_CONFIG_HOME:-$HOME/.config}/opentoon  (kept on uninstall/rollback)"
}

cmd_check() {
  need node
  local f cur; f="$(installed_info)"
  cur="$(info_field "$f" version)"
  [ -n "$cur" ] || cur="$(node -p 'require(process.argv[1]).version' "$REPO/package.json")"
  local rc=0
  node "$REPO/tools/check-update.cjs" --current "$cur" "$@" || rc=$?
  if [ "$rc" -eq 10 ] && [ "${1:-}" != "--json" ]; then
    echo "To review and install it: $APP_ID-update update"
  fi
  return "$rc"
}

cmd_rollback() {
  [ -L "$OPT/previous" ] && [ -d "$OPT/previous" ] || die "no previous version to roll back to"
  local cur prev; cur="$(readlink "$OPT/current")"; prev="$(readlink "$OPT/previous")"
  ln -sfn "$prev" "$OPT/current"
  ln -sfn "$cur" "$OPT/previous"
  info "rolled back: now running $(basename "$prev") (was $(basename "$cur")). Restart OpenToon if it is open."
}

cmd_uninstall() {
  info "removing OpenToon Studio from $PREFIX"
  rm -f -- "$BIN/$APP_ID" "$BIN/$APP_ID-update" "$DATA/applications/$APP_ID.desktop" \
    "$DATA/mime/packages/$APP_ID.xml" "$DATA/icons/hicolor/scalable/apps/$APP_ID.svg" \
    "$DATA/icons/hicolor/scalable/mimetypes/application-x-opentoon.svg"
  for s in $ICON_SIZES; do rm -f -- "$DATA/icons/hicolor/${s}x${s}/apps/$APP_ID.png"; done
  rm -rf -- "$OPT"
  local mimeapps="${XDG_CONFIG_HOME:-$HOME/.config}/mimeapps.list"
  [ -f "$mimeapps" ] && sed -i "\#^application/x-opentoon=$APP_ID.desktop;\?\$#d" "$mimeapps"
  refresh_desktop_caches
  info "done. Projects and settings (${XDG_CONFIG_HOME:-$HOME/.config}/opentoon) were left in place."
}

cmd_update() {
  need git; need node; need npm
  local approve="" to="" gui_test=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --approve) approve="${2:-}"; shift 2 ;;
      --to) to="${2:-}"; shift 2 ;;
      --skip-gui-test) gui_test=0; shift ;;
      *) die "unknown update option: $1" ;;
    esac
  done
  local f; f="$(installed_info)"
  [ -f "$f" ] || die "not installed yet — run: $0 install"
  local cur_version cur_tag port_branch
  cur_version="$(info_field "$f" version)"
  cur_tag="$(info_field "$f" upstream_tag)"
  port_branch="$(info_field "$f" port_branch)"

  info "fetching release tags from $(git -C "$REPO" remote get-url origin)"
  git -C "$REPO" fetch --tags --quiet origin || die "git fetch failed (offline?) — nothing was changed"

  local target="$to"
  if [ -z "$target" ]; then
    local json rc=0
    json="$(node "$REPO/tools/check-update.cjs" --current "$cur_version" --json)" || rc=$?
    case "$rc" in
      0) echo "Already up to date ($cur_version)."; return 0 ;;
      10) target="$(printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).tag))')" ;;
      *) printf '%s\n' "$json" >&2; die "update check failed — nothing was changed" ;;
    esac
  fi
  git -C "$REPO" rev-parse -q --verify "refs/tags/$target" >/dev/null || die "tag $target not found after fetch"
  local new_version="${target#v}"

  # does the release already contain the Linux support this install was built with?
  local merge_branch=""
  if [ -n "$port_branch" ] && git -C "$REPO" rev-parse -q --verify "refs/heads/$port_branch" >/dev/null; then
    if ! git -C "$REPO" merge-base --is-ancestor "$port_branch" "$target"; then merge_branch="$port_branch"; fi
  fi

  echo
  echo "Update: $cur_version -> $new_version  ($target)"
  local base="$cur_tag"
  git -C "$REPO" rev-parse -q --verify "$base^{commit}" >/dev/null 2>&1 || base="$(git -C "$REPO" merge-base HEAD "$target")"
  echo "Upstream changes $base..$target:"
  git -C "$REPO" log --oneline --no-decorate "$base..$target" | sed 's/^/  /'
  git -C "$REPO" diff --stat "$base" "$target" | tail -n 1 | sed 's/^/  /'
  local sensitive
  sensitive="$(git -C "$REPO" diff --name-only "$base" "$target" -- package.json package-lock.json electron .github tools || true)"
  if [ -n "$sensitive" ]; then
    echo "Review these (dependencies, main process, build/CI scripts):"
    printf '%s\n' "$sensitive" | sed 's/^/  /'
  fi
  [ -n "$merge_branch" ] && echo "Linux support: merging local branch '$merge_branch' on top of $target."
  echo "Approving runs 'npm ci' (installs dependencies, incl. Electron's download script),"
  echo "the test suite and a GUI smoke test, then installs. The current version stays as rollback."
  echo

  if [ "$approve" != "$new_version" ] && [ "$approve" != "$target" ]; then
    [ -n "$approve" ] && die "--approve $approve does not match the update ($new_version) — nothing was changed"
    if [ -t 0 ]; then
      local answer; read -r -p "Type $new_version to approve, anything else cancels: " answer
      [ "$answer" = "$new_version" ] || [ "$answer" = "$target" ] || { echo "Cancelled. Nothing was changed."; return 1; }
    else
      die "approval required: rerun with --approve $new_version — nothing was changed"
    fi
  fi

  local work log; work="$(mktemp -d "${TMPDIR:-/tmp}/opentoon-update.XXXXXX")"
  mkdir -p "$OPT/logs"; log="$OPT/logs/update-$(date +%Y%m%d-%H%M%S)-$new_version.log"
  info "building in $work (log: $log)"
  cleanup() { git -C "$REPO" worktree remove --force "$work/src" >/dev/null 2>&1 || true; rm -rf -- "$work"; }
  trap cleanup EXIT
  fail() { echo "error: $* — the installed version was NOT changed. Details: $log" >&2; exit 1; }

  git -C "$REPO" worktree add --quiet --detach "$work/src" "$target" >>"$log" 2>&1 || fail "could not check out $target"
  if [ -n "$merge_branch" ]; then
    git -C "$work/src" merge --no-edit --quiet "$merge_branch" >>"$log" 2>&1 \
      || fail "branch '$merge_branch' does not merge cleanly onto $target (resolve it in $REPO, then retry)"
  fi
  ( cd "$work/src" && npm ci ) >>"$log" 2>&1 || fail "npm ci failed"
  info "running tests"
  ( cd "$work/src" && npm test ) >>"$log" 2>&1 || fail "npm test failed"
  info "packaging"
  ( cd "$work/src" && npm run dist:linux ) >>"$log" 2>&1 || fail "packaging failed"
  if [ "$gui_test" = 1 ] && { [ -n "${WAYLAND_DISPLAY:-}" ] || [ -n "${DISPLAY:-}" ]; }; then
    info "GUI smoke test of the new build"
    ( cd "$work/src" && node tests/electron-smoke.cjs dist/linux-unpacked/$APP_ID --ozone-platform-hint=auto ) >>"$log" 2>&1 \
      || fail "GUI smoke test failed"
  else
    echo "(skipping GUI smoke test: no display or --skip-gui-test)"
  fi
  cmd_install "$work/src/dist/linux-unpacked" "$work/src" "$target" "$port_branch" | tee -a "$log"
  info "updated to $new_version. Previous version kept: '$APP_ID-update rollback' to go back."
}

usage() { sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

cmd="${1:-help}"; shift || true
case "$cmd" in
  install) cmd_install "$@" ;;
  status) cmd_status ;;
  check) cmd_check "$@" ;;
  update) cmd_update "$@" ;;
  rollback) cmd_rollback ;;
  uninstall) cmd_uninstall ;;
  help|-h|--help) usage ;;
  *) usage; exit 64 ;;
esac
