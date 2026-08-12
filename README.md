# Consort Desktop

[![XO code style](https://img.shields.io/badge/code_style-XO-5ed9c7.svg)](https://github.com/sindresorhus/xo)

Desktop client for [Consort](https://github.com/Dyslectric/consort). A fork of
[Zulip Desktop](https://github.com/zulip/zulip-desktop), which it otherwise still is: sign in to
several organizations at once, desktop notifications with inline reply, tray and dock integration,
spell checking.

The fork exists because Consort puts calls _inside_ the app. A call runs in an iframe served by the
organization's video server, so it asks for a camera and a microphone — and the stock client
answers no to everything except notifications, silently, which makes a call join with no audio, no
video and nothing on screen to explain it.

## What is different from upstream

**Calls can ask for a camera and a microphone, and you are asked first.** The permission is per
organization and per device: an organization you run yourself and one you were invited to are not
the same decision, and neither is being heard and being seen.

The prompt is a banner drawn by the app above the page, not inside it — a prompt rendered by the
page is a prompt the page can forge, and this one exists precisely so it cannot be. When both
devices are asked for, "Allow microphone" is an answer as well as "Allow both".

Answers are remembered per organization and can be changed later in **Settings → Organizations**.
Disconnecting an organization forgets them, so reconnecting asks again rather than resuming a
decision made in a relationship that has ended.

## Not yet supported

**Screen sharing.** Electron shows no picker of its own for `getDisplayMedia`, so an application has
to enumerate the available screens and windows and present them itself. Until that exists, screen
sharing works in a browser and not here.

**Packaged builds.** Run it from source for now. The packaging inherited from upstream still
identifies itself as Zulip Desktop and, having no `publish` block of its own, derives its update feed
from the `repository` field — which still points at the project this was forked from. A build made
today would therefore install over Zulip Desktop and then update itself back into it. Three fields
fix that, and none of them are worth setting until there is something to release.

## Development

```bash
pnpm install
pnpm run dev
```

`pnpm run test` runs the same checks CI does: TypeScript, XO, stylelint, htmlhint and Prettier.
See [development.md](./development.md).

## Reporting issues

Most of what you see in an organization's window comes from the Consort server and its web app, not
from this client. Problems with channels, messages, or the call panel itself belong in the
[Consort project](https://github.com/Dyslectric/consort/issues/new); problems with the desktop shell
— window handling, notifications, the tray, permission prompts, updates — belong here.

## License

Released under the [Apache-2.0](./LICENSE) license, as is the Zulip Desktop client it is derived
from. Zulip is a trademark of Kandra Labs, Inc.; this is an independent fork and is not affiliated
with or endorsed by them.
