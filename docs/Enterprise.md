# Configuring Consort Desktop for multiple users

If you're a system admin and want to add certain organizations to the Consort app for
all users of your system, you can do so by creating an enterprise config file.
The file should be placed at `/etc/consort-desktop-config` for Linux and macOS computers
and inside `C:\Program Files\Consort-Desktop-Config` on Windows.
It must be named `global_config.json` in both cases.

To specify the preset organization you want to add for other users, you will need to
add the `json` shown below to the `global_config.json`. Replace `https://consort.example.com` with the
organization you want to add. You can also specify multiple organizations.

```json
{
  "presetOrganizations": ["https://consort.example.com"],
  "autoUpdate": false
}
```

The above example adds that organization to Consort every time the app is loaded.
Users can add new organizations at all times, but cannot remove any organizations listed under `presetOrganizations`.

If you'd like to remove organizations and have admin access, you'll need to change the config file and remove the concerned URL from the `value` field.

It also turns off automatic updates for every Consort user on the same machine.

Currently, we only support `presetOrganizations` and `autoUpdate` settings.
