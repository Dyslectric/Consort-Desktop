#!/bin/bash

# Link to the binary
ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'

# SUID chrome-sandbox for Electron 5+
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

update-mime-database /usr/share/mime || true
update-desktop-database /usr/share/applications || true

# Clean up configuration for old Bintray repository
rm -f /etc/apt/zulip.list

# Clean up legacy APT configuration
rm -f /etc/apt/sources.list.d/zulip-desktop.list /etc/apt/trusted.gpg.d/zulip-desktop.asc

# This package used to install Zulip's APT repository, inherited from upstream.
# It no longer does -- Consort publishes no APT repository and had no business
# subscribing a machine to someone else's. Dropping the files from the package
# does not remove them from a machine that already has them, so remove them here.
rm -f /etc/apt/sources.list.d/zulip-desktop.sources \
      /usr/share/keyrings/zulip-desktop.asc \
      /etc/update-manager/release-upgrades.d/zulip-desktop.cfg
