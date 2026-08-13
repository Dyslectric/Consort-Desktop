#!/bin/sh
# Install Consort from the extracted tar.xz archive.
#
#   sudo sh install.sh              install to /opt/Consort-Desktop
#   sudo sh install.sh --uninstall  remove it again
#
# Invoked as `sh install.sh` rather than `./install.sh` because the archive is
# built on whatever CI runs, and the executable bit does not reliably survive
# the trip. Both work if the bit is there.

set -eu

# An exported CDPATH makes `cd` print and resolve elsewhere, which would send
# the install somewhere surprising.
unset CDPATH

PREFIX=/opt/Consort-Desktop
ENTRY=/usr/share/applications/consort.desktop
LINK=/usr/local/bin/consort-desktop
BIN=consort-desktop

here=$(cd -- "$(dirname -- "$0")" && pwd)

die() {
    echo "install.sh: $*" >&2
    exit 1
}

need_root() {
    [ "$(id -u)" = 0 ] || die "needs root. Try: sudo sh $0 $*"
}

# Only ever delete a directory that is demonstrably a Consort install. $PREFIX
# is a constant here, but this script runs as root and a typo in it would be
# unrecoverable, so the check is worth its three lines.
remove_prefix() {
    [ -e "$PREFIX" ] || return 0
    [ -f "$PREFIX/$BIN" ] ||
        die "$PREFIX exists but has no $BIN in it. Refusing to delete it; remove it yourself if it is stale."
    rm -rf -- "$PREFIX"
}

refresh_menus() {
    # Neither is fatal: the entry is already on disk, and a desktop that has no
    # database still reads the directory.
    [ -x "$(command -v update-desktop-database || true)" ] &&
        update-desktop-database /usr/share/applications 2>/dev/null || true
    [ -x "$(command -v gtk-update-icon-cache || true)" ] &&
        gtk-update-icon-cache -q /usr/share/icons/hicolor 2>/dev/null || true
}

uninstall() {
    need_root --uninstall
    remove_prefix
    rm -f -- "$ENTRY"
    # Only our own symlink, not a file someone else put there.
    [ -L "$LINK" ] && rm -f -- "$LINK" || true
    refresh_menus
    echo "Removed $PREFIX, $ENTRY and $LINK."
}

install() {
    need_root
    [ -f "$here/$BIN" ] ||
        die "no $BIN next to this script. Run it from inside the extracted archive."
    [ "$here" != "$PREFIX" ] ||
        die "already running from $PREFIX. Extract the archive somewhere else and run it from there."

    remove_prefix
    mkdir -p -- "$PREFIX"
    cp -a -- "$here"/. "$PREFIX"/

    # Electron's sandbox helper must be setuid-root or Chromium refuses to start
    # with "SUID sandbox helper binary is not configured correctly".
    [ -f "$PREFIX/chrome-sandbox" ] && chmod 4755 -- "$PREFIX/chrome-sandbox" || true

    # Set these explicitly rather than trusting the archive. A tar built on a
    # filesystem with no executable bit -- Windows, most obviously -- carries
    # every file as 0644, and the failures do not look like a packaging problem:
    # a permission-denied on launch from the binary, and from the libraries an
    # abort about missing graphics support, because Chromium cannot load its own
    # .so files.
    #
    # Globs that match nothing stay literal in sh, which the -f guard absorbs.
    for f in \
        "$PREFIX/$BIN" \
        "$PREFIX/chrome_crashpad_handler" \
        "$PREFIX"/*.so \
        "$PREFIX"/*.so.*; do
        [ -f "$f" ] && chmod 0755 -- "$f" || true
    done

    # The shipped entry points at the default prefix; rewrite both paths so the
    # entry is correct even if PREFIX is edited above.
    [ -f "$here/resources/consort.desktop" ] ||
        die "resources/consort.desktop is missing from the archive."
    sed -e "s|^Exec=.*|Exec=$PREFIX/$BIN|" \
        -e "s|^Icon=.*|Icon=$PREFIX/resources/icon.png|" \
        -- "$here/resources/consort.desktop" > "$ENTRY"
    chmod 0644 -- "$ENTRY"

    ln -sfn -- "$PREFIX/$BIN" "$LINK"
    refresh_menus

    echo "Consort installed."
    echo "  files    $PREFIX"
    echo "  launcher $ENTRY"
    echo "  command  $LINK"
}

case "${1-}" in
    --uninstall | -u) uninstall ;;
    "") install ;;
    *) die "unknown argument: $1 (expected --uninstall, or nothing)" ;;
esac
