# Pluto TV

This is an unofficial [10-foot UI][10foot] for [Pluto TV][plutotv], Paramount's
free ad-supported streaming service. The UI is designed specifically for
jailbroken PS5 and is built along the same lines as [the TV4 Play UI][tv4play]
and [the SVT Play UI][svtplay].

The majority of the UI has been produced by [claude.ai][claude].

> [!NOTE]
> There is nothing to sign in to. Pluto TV is free and anonymous, so this UI
> asks for no credentials and stores none — only a device id it generates once.

> [!NOTE]
> Pluto TV is region-locked, and the region is decided by the address the
> console connects from. The catalogue, the channel lineup and the language
> all follow from it. *Status* shows which region came back.

The views are the ones pluto.tv puts in its own header — Home, Live TV, Movies
and Shows — plus Search, which the site keeps behind an icon, and Status, which
has no equivalent because a browser does not have to be told which region it
resolved to.

## Controls

| Button       | Browsing                        | Playback                  |
|--------------|---------------------------------|---------------------------|
| D-pad        | Move; Left at the edge exits to the menu | Seek ±10 s / ±5 min |
| Cross        | Open                            | Play / pause              |
| Circle       | Back                            | Stop                      |
| Square       | —                               | Cycle subtitles           |
| Triangle     | Reload the current view         | Cycle audio tracks        |

Moving down the menu opens each view as the cursor settles on it; Right or
Cross hands the cursor over to the listing.

The television's own remote works as well as the pad. The browser turns
HDMI-CEC presses into key events of their own, and they are handled alongside
the pad buttons:

| Key                   | Browsing                     | Playback                      |
|-----------------------|------------------------------|-------------------------------|
| Top menu              | To the menu                  | Stop, then to the menu        |
| Guide                 | Open Kanaler                 | Leave playback for Kanaler    |
| Channel Up / Down     | Move a screenful; in the menu, an item | Next / previous in the list |
| Track Next / Previous | —                            | Next / previous in the list   |
| Play / Pause          | —                            | Play / pause                  |
| Stop                  | —                            | Stop                          |
| Rewind / Fast forward | —                            | Seek ±30 s                    |
| Subtitle              | —                            | Cycle subtitles               |
| Info (context)        | —                            | Show / hide the OSD           |
| Red                   | Reload the current view      | Restart the stream            |
| Green                 | Open                         | Play / pause                  |
| Yellow                | —                            | Cycle subtitles               |
| Blue                  | —                            | Cycle audio tracks            |

Red and Green do what Triangle and Cross do on the pad, so nothing is lost by
putting the pad down. "The list" is whatever the current item was started
from — the rest of a season, or the other channels in the category — with
folders skipped over rather than opened.

A held key repeats only where the action is a small step: the D-pad, Rewind
and Fast forward. Channel Up held down would otherwise change programme a
dozen times, each one a fresh stream.

## Installing

Assuming you have [elfldr.elf][elfldr] running on your PS5, a launcher can be
installed by running the install payload on your PS5. A Pluto TV icon will then
appear on the Media tab on your PS5 dashboard.

The payload embeds everything in `webapp/` and writes it to
`/user/app/BREW10005/`, alongside the launcher metadata. `webAppUri` in
`sce_sys/param.json` then points the browser at that directory, served locally
by [websrv][websrv]. The title id in `param.json` and in the `Makefile` must
match, and must be unique among the apps installed on the console — note that
it differs from the TV4 Play UI's, so the two can be installed side by side.

> [!NOTE]
> Once the installation is completed, the application can be launched without
> having to jailbreak the console after a reboot.

`sce_sys/icon0.png` and `sce_sys/pic1.png` are the placeholders inherited from
the TV4 Play UI so that `make` works out of the box. Replace them with artwork
of your own.

The colours live in the `:root` block at the top of `webapp/app.css` and
nowhere else — a dark blue-black lifted a step at a time for surfaces, with one
saturated yellow doing all the pointing. Changing `--accent` recolours every
focus ring, the loading bar and the section rules at once.

## How it works

Everything starts at `boot.pluto.tv/v4/start`, which takes a description of the
device and hands back a session token. That token is the only credential in
play: it authorises the JSON calls, it carries the region, and it goes into the
playback URL. It lives in memory, expires within the hour, and `pluto.js` mints
a fresh one when it does.

Two requests then cover the whole catalogue:

- **Live** comes from `api.pluto.tv/v2/channels`. Given a time window it
  returns the entire lineup *and* what each channel is showing, so Kanaler and
  its now-playing text cost one call rather than a lineup followed by a
  schedule lookup per hundred channels. `service-channels.clusters.pluto.tv` is
  tried only if that fails — the same channels in a different shape, worth
  having as a second door rather than a first.
- **On demand** comes from `api.pluto.tv/v3/vod/categories` asked with
  `includeItems=true`, which returns every category with its titles inline.
  Home, Movies and Shows are all served from that one answer: films and shows
  are mixed together inside each category, so the two views are the same rows
  filtered two ways rather than two different requests. A category holding
  nothing of the kind being asked for drops out instead of drawing an empty
  shelf.

  Pluto labels a title's type, but not always — some carry only a list of
  season numbers. Having seasons is what makes something a show here.

A series is fetched whole — `v3/vod/series/{id}/seasons` returns every episode
of every season — which is why a season has no id of its own here and entries
carry `season:{seriesId}:{number}` instead.

Playback needs no request at all. The stitcher takes the id, the device
description and the token in the URL itself and answers with an HLS manifest
that has advertising already spliced into it.

Every manifest URL is rebuilt from scratch rather than used as the catalogue
gave it: the host comes from `servers.stitcher` in the boot response, the path
is forced under `/v2`, and the query is the session's own. That matters because
catalogue entries still hand out absolute URLs pointing at retired stitcher
hosts with `/v1` paths and stale tokens baked in, and using one of those gets
the slate described below rather than the title.

The endpoints and the boot parameters were taken from the [Pluto TV plugin for
Enigma2][enigma] and [pluto-for-channels][channels], both GPL like this
repository.

### Things that will need touching up

Far less than in the TV4 Play UI, which has to name the curated rows of the
start page by opaque id and watch them rot. Nothing here is addressed that way:
the rows are the live lineup and the categories Pluto returns, in Pluto's
order, so a reshuffle of the catalogue turns up on its own.

What is left:

- **`SEARCH_API`** is the least certain thing in `pluto.js`. It is parsed
  defensively — three possible envelope shapes — but if search comes back empty
  while browsing works, that endpoint is where to look.
- **`APP_VERSION`** is what the website sends. Pluto has not historically been
  fussy about it, but it is the first thing to bump if boot starts refusing.
- **`STITCHER_FALLBACK`** is only reached when a boot response names no
  stitcher of its own, which it normally does.

## No DRM, deliberately

The console reports **PlayReady** through EME, and neither Widevine nor
FairPlay. A desktop browser's boot request advertises `widevine:L3`, and asking
for that here would earn a manifest the console cannot decrypt.

So this client advertises no DRM capability at all. Pluto reads that as a
client that cannot handle protection and serves the unencrypted rendition,
which is the one the console decodes in hardware. That is why there is no Shaka
Player here, no licence exchange, and no second playback path: everything is
plain HLS, played natively, with hls.js loaded only for the case where the
audio sits in renditions of its own — which WebKit loads no sound for.

### "Pluto TV is no longer available on this device"

If a title starts playing and shows a slate saying this, cycling through
several languages, the browsing half of the UI is working and the playback URL
is wrong. Pluto began serving that slate to third-party clients in late
February 2026; it broke every unofficial client at once, and it is a perfectly
ordinary playable stream, so nothing errors and nothing retries — it simply
plays the wrong content.

Three things have to be right to get the title instead, all of them in
`stitchUrl()` and `stitchPath()`:

- the request goes to the stitcher **this session** named, not one remembered
  from a catalogue entry;
- the path sits under **`/v2`**, exactly once;
- the query carries the session's `stitcherParams`, the `jwt`, plus
  **`masterJWTPassthrough=true`** and **`includeExtendedEvents=true`**.

The last one reads like a request for richer metadata rather than a gate on
playback, but the clients that work send it. It was identified in
[streamlink#6851][slfix], which is the reference to reach for if the slate ever
comes back.

Should that happen, compare the URL this UI logs to the console — `resolve()`
prints every one — against what pluto.tv itself requests in a desktop browser's
network tab. The difference will be in those parameters.

## Known unknowns

**CORS is the thing to test first.** Every listing call is an ordinary `fetch`,
and it only works if Pluto's services answer with an
`Access-Control-Allow-Origin` the browser will accept for a page served off a
local path. The TV4 Play UI has the same dependency and its auth service
answers only for origins it recognises; whether Pluto's does the same has not
been established here.

Playback is unaffected either way: a native HLS `<video>` source is not subject
to CORS, so if browsing works, playing will.

A two-line check from the console's browser settles it before anything else is
worth investigating:

```js
fetch("https://boot.pluto.tv/v4/start?appName=web&appVersion=9.1.0" +
      "&deviceType=web&deviceModel=web&deviceMake=chrome&clientID=test" +
      "&clientModelNumber=1.0.0&serverSideAds=false")
  .then(r => r.json()).then(j => console.log(j.sessionToken ? "ok" : j));
```

If that logs `ok`, the rest follows. If it fails with a CORS error, the same
reasoning applies as in the TV4 Play UI: the origin is set by the browser and
cannot be spoofed from script, and serving the UI from the console over
`localhost` is the one lever available.

## Not implemented

- **Ad skipping.** Pluto stitches advertising into its manifests server-side.
  It plays as part of the stream; nothing here separates it out, and the
  service is free because of it.
- **A programme guide.** Kanaler shows what is on now, taken from the EPG that
  arrives with the lineup, but there is no grid and no way to browse forward.
- **Continue watching.** Playback positions are kept per title on the console,
  as in the TV4 Play UI, but nothing surfaces them as a row.

## Reporting Issues

If you encounter problems with this unofficial Pluto TV UI, please file a
github issue. If you plan on sending pull requests which affect more than a few
lines of code, please file an issue before you start to work on your changes.
This will allow us to discuss the solution properly before you commit time and
effort.

## License
[GPLv3+][gplv3]

[plutotv]: https://pluto.tv
[tv4play]: https://github.com/ps5-payload-dev/tv4play
[svtplay]: https://github.com/ps5-payload-dev/svtplay
[claude]: https://claude.ai
[elfldr]: https://github.com/ps5-payload-dev/elfldr
[websrv]: https://github.com/ps5-payload-dev/websrv
[enigma]: https://github.com/oe-alliance/PlutoTV
[channels]: https://github.com/jgomez177/pluto-for-channels
[gplv3]: https://www.gnu.org/licenses/gpl-3.0.html
[slfix]: https://github.com/streamlink/streamlink/pull/6851
[10foot]: https://en.wikipedia.org/wiki/10-foot_user_interface
