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
> all follow from it.

The views are the ones pluto.tv puts in its own header — Home, Live TV, Movies
and Shows.

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

  `offset` on that endpoint is the page size for the category list rather than
  a starting point, and it defaults to 100 while there are rather more
  categories than that — so it is asked for a thousand, which is the whole
  list. The items inside a category have no such lever: they are capped at a
  hundred however the request is phrased, and `totalItemsCount` is how a
  category says it is holding more than it handed over. A shelf that was capped
  counts what it actually has and marks it `100+` rather than naming a total it
  cannot stand behind.

  Home, Movies and Shows are all served from that one answer.

  Movies and Shows are navigated by *genre*, which is what pluto.tv itself
  does — Action & Adventure, Comedy, Sci-Fi & Fantasy, Drama, Romance,
  Thriller, Documentaries, Horror — and not by category. The categories are a
  different thing: there are getting on for four hundred of them, they overlap
  heavily (one film sits in Top Titles and in an A-Z and in a themed
  collection), and plenty are editorial rather than navigational. A shelf per
  category is why Movies used to look nothing like the site.

  Every on-demand item names its own genre, so the grouping is built from the
  items rather than asked for: collect the catalogue, drop the duplicates,
  bucket what is left. Genre names therefore arrive in whatever language the
  region answers in, as they do on the site. The genres are ordered fullest
  first — Pluto's own order is editorial and is not in the response, so there
  is nothing faithful to copy.

  Labelling an item a film is not the same as belonging in Movies. A handball
  match, a diving championship and an MTV Unplugged concert all come back typed
  `movie` — each with its own `seriesID`, no seasons, nothing in the item to say
  otherwise — and the site files them under Sport, under Musik and under the
  series *MTV Unplugged*. Nothing on the item separates them from a documentary
  or a stand-up special, which do belong in Movies.

  The catalogue answers it indirectly. Its categories are grouped by
  `mainCategories` into a dozen or so sections, and one of them holds nothing
  but films — not a single series among them. That is where the site's own
  Movies rows come from, so the genres appearing in it are, by construction, the
  genres Pluto treats as film genres. Sports and Music are never among them;
  Documentary, Comedy, Drama and Horror always are.

  So that section is read for its *genres* rather than its contents, and every
  film in those genres counts wherever it happens to be filed. Reading it for
  its contents instead would lose the documentaries and the stand-up, which live
  in mixed sections of their own. Nothing here is named or numbered: the section
  ids are regional, the genre list is whatever that section turns out to hold,
  and both are read afresh from every response. A catalogue with no film-only
  section falls back to leaving every film where it is.

  Inside a genre the titles are alphabetical, which is what the site's own A-Z
  row does — it runs "100 Below Zero", "40 Days and Nights", "7 Days to Vegas",
  "A Time For Dying", so a plain string order rather than a numeric one. The
  genres are alphabetical for the same reason: Pluto's order is editorial and
  is not in the response, so there is nothing faithful to copy, and the order
  the viewer can predict is the next best thing. It also opens on Action &
  Adventure, as the site's own row does.

  Sorting asks the session which language the catalogue is in, because a naive
  comparison files Å, Ä and Ö among the As and Os where Swedish puts them after
  Z. The tag comes out of a JWT rather than from here and `Intl` is not on every
  browser this runs in, so each step is tried and neither is trusted.

  What goes into which half is otherwise asked for by name. Having seasons — or being
  labelled a series — is what makes something a show; being labelled a film is
  what makes something a film. The catalogue holds more than the two: Sports
  and News are full of single items that are neither, and taking "not a series"
  for a film swept every one of them into Movies. They are still in the
  catalogue and still reachable from Home; they are simply not films.

  Asking for the label only works while the label is there to ask for, and not
  every region's catalogue is filled in to the same standard. So the response is
  checked once when it is fetched, and if nothing in it is labelled a film at
  all, the older, looser test is used instead — a Movies view carrying a few
  things that are not films beats an empty one.

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

- **`APP_VERSION`** is what the website sends. Pluto has not historically been
  fussy about it, but it is the first thing to bump if boot starts refusing.
- **`STITCHER_FALLBACK`** is only reached when a boot response names no
  stitcher of its own, which it normally does.

## When a stream will not start

WebKit's own HLS is the default path on this console, and its failure mode for
a manifest it cannot use is to say nothing at all — no `loadedmetadata`, no
`error` event, nothing to hang a message on. The spinner then turns for ever,
which tells the viewer only that something is wrong and never what.

So playback has a deadline. Fifteen seconds without a decoded frame is treated
as a failure, and hls.js is given one turn at the same manifest before the
stream is called dead: it demuxes differently, sometimes gets through where
WebKit will not, and where it cannot it at least names the codec it choked on
rather than going quiet.

If that fails too, the manifest's own `CODECS` are put to
`MediaSource.isTypeSupported` and to the element's `canPlayType`, and whatever
neither will accept is named in the message — "The console has no decoder for
HEVC" rather than a spinner. Each codec is asked about separately, since a
rendition names its video and audio together and asking about the pair would
blame the AAC alongside the HEVC that is actually the trouble. Both are asked
because WebKit's built-in HLS never goes through MediaSource at all, and a
console can play something natively that it refuses through MSE.

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
