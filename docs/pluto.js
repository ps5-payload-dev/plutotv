/*
 * Pluto TV API.
 *
 * Everything starts at boot.pluto.tv, which hands out a short lived session
 * token in exchange for a description of the device. That token is the only
 * credential there is: Pluto is free and anonymous, so there is no sign-in to
 * drive and nothing to store on the console but a device id.
 *
 * The token also decides the region. Pluto works out where the caller is from
 * the address the boot request arrives on and writes the answer into the
 * token, so the catalogue is whatever the console's own connection is entitled
 * to see -- SE from a Swedish line. Status shows which one came back.
 *
 * Listings come from two places. Live channels and their EPG come from
 * api.pluto.tv/v2/channels, which returns the whole lineup in one response and
 * fills in what is on now when it is given a time window. On-demand comes from
 * the VOD service, whose category listing carries its items inline -- so the
 * home page, the category list and every category behind it are all served by
 * a single request.
 *
 * Playback is a URL built from the token rather than a request of its own:
 * the stitcher takes a channel or episode id and returns an HLS manifest with
 * advertising already spliced in. Nothing Pluto serves this client is
 * encrypted -- see resolve() -- so there is no licence exchange anywhere here.
 */
var Pluto = (function () {
    "use strict";

    var BOOT_API = "https://boot.pluto.tv/v4/start";
    var API = "https://api.pluto.tv";
    var CHANNELS_API = "https://service-channels.clusters.pluto.tv";
    var SEARCH_API = "https://service-media-search.clusters.pluto.tv/v1/search";
    var IMAGE_HOST = "https://images.pluto.tv";

    // Where the manifests come from. The boot response names the stitcher it
    // wants this session to use, and that is what gets used; this is only what
    // to fall back on when it names none.
    var STITCHER_FALLBACK =
        "https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv";

    // What this client claims to be. Pluto reads these to decide which
    // catalogue to serve and how to bill the advertising, and the web values
    // are the ones that produce an ordinary HLS stream.
    var APP_NAME = "web";
    var APP_VERSION = "9.1.0";
    var DEVICE_TYPE = "web";
    var DEVICE_MODEL = "web";
    var DEVICE_MAKE = "chrome";
    var DEVICE_VERSION = "122.0.0";
    var CLIENT_MODEL = "1.0.0";

    /*
     * Deliberately absent: drmCapabilities.
     *
     * The console has PlayReady and neither Widevine nor FairPlay, so claiming
     * "widevine:L3" the way a desktop browser does would earn a manifest it
     * cannot decrypt. Saying nothing means Pluto treats this as a client that
     * cannot handle protection at all, and serves the unencrypted rendition --
     * which is the one the console decodes in hardware. If a title ever comes
     * back encrypted anyway, resolve() says so rather than failing silently.
     */

    var STORE_DEVICE = "plutotv.device_id";

    // Live channels change what they are showing, so the EPG that arrives with
    // them goes stale faster than the catalogue does.
    var CACHE_TTL_MS = 10 * 60 * 1000;
    var CHANNEL_TTL_MS = 5 * 60 * 1000;
    var cache = {};

    // How far ahead of now to ask for programme data. Two hours is enough for
    // "now, and what follows" without pulling down a day of schedule.
    var EPG_WINDOW_MIN = 120;

    var SEARCH_LIMIT = 60;

    /* --------------------------------------------------------------- misc */

    function readStore(key) {
        try {
            return window.localStorage.getItem(key) || "";
        } catch (e) {
            return "";
        }
    }

    function writeStore(key, value) {
        try {
            if (value) {
                window.localStorage.setItem(key, value);
            } else {
                window.localStorage.removeItem(key);
            }
        } catch (e) {
            // Private browsing, a full quota -- nothing here is worth failing
            // a listing over.
        }
    }

    function uuid() {
        var s = "";
        var i;
        for (i = 0; i < 36; i++) {
            if (i === 8 || i === 13 || i === 18 || i === 23) {
                s += "-";
            } else if (i === 14) {
                s += "4";
            } else {
                var r = Math.floor(Math.random() * 16);
                s += (i === 19 ? (r & 3) | 8 : r).toString(16);
            }
        }
        return s;
    }

    /*
     * The device this console presents itself as.
     *
     * Kept rather than minted per session because that is what a television
     * does, and because Pluto uses it to keep a lineup stable between visits.
     * It identifies the console to Pluto and nothing else; there is no account
     * behind it.
     */
    function deviceId() {
        var id = readStore(STORE_DEVICE);
        if (!id) {
            id = uuid();
            writeStore(STORE_DEVICE, id);
        }
        return id;
    }

    // One session id for as long as the app is open, which is what ties a run
    // of requests together on Pluto's side.
    var sessionId = uuid();

    function cached(key, produce, ttl) {
        var now = Date.now();
        var hit = cache[key];
        if (hit && now - hit.at < (ttl || CACHE_TTL_MS)) {
            return hit.value;
        }
        var value = produce();
        cache[key] = {at: now, value: value};

        // A rejected promise must not be what the next caller gets back.
        value["catch"](function () {
            if (cache[key] && cache[key].value === value) {
                delete cache[key];
            }
        });
        return value;
    }

    function clearCache() {
        cache = {};
    }

    function text(s) {
        return String(s == null ? "" : s).trim();
    }

    function get(obj, path) {
        var parts = path.split(".");
        var cur = obj;
        var i;
        for (i = 0; i < parts.length; i++) {
            if (cur == null) {
                return null;
            }
            cur = cur[parts[i]];
        }
        return cur == null ? null : cur;
    }

    function query(params) {
        var out = [];
        Object.keys(params).forEach(function (k) {
            if (params[k] === null || params[k] === undefined) {
                return;
            }
            out.push(encodeURIComponent(k) + "=" +
                     encodeURIComponent(params[k]));
        });
        return out.join("&");
    }

    /* ------------------------------------------------------------ session */

    function jwtPayload(token) {
        try {
            var part = token.split(".")[1];
            var pad = part.replace(/-/g, "+").replace(/_/g, "/");
            while (pad.length % 4) {
                pad += "=";
            }
            return JSON.parse(window.atob(pad));
        } catch (e) {
            return null;
        }
    }

    var session = null;      // the live one
    var sessionAt = 0;       // when it was minted
    var pending = null;      // a boot already in flight
    var lastError = null;

    function bootParams() {
        return {
            appName: APP_NAME,
            appVersion: APP_VERSION,
            deviceType: DEVICE_TYPE,
            deviceModel: DEVICE_MODEL,
            deviceMake: DEVICE_MAKE,
            deviceVersion: DEVICE_VERSION,
            deviceId: deviceId(),
            clientID: deviceId(),
            clientModelNumber: CLIENT_MODEL,
            sid: sessionId,
            serverSideAds: "false",
            blockingMode: ""
        };
    }

    function boot() {
        var url = BOOT_API + "?" + query(bootParams());

        return fetch(url, {
            method: "GET",
            headers: {"Accept": "application/json"}
        }).then(function (res) {
            if (!res.ok) {
                throw new Error("Pluto svarade " + res.status +
                                " to the session request");
            }
            return res.json();
        }).then(function (json) {
            var token = text(json.sessionToken);
            if (!token) {
                throw new Error("No session token from Pluto");
            }

            var claims = jwtPayload(token) || {};

            /*
             * The stitcher wants the same device description the boot request
             * carried, and the response usually hands back a prepared query
             * string saying exactly that. Where it does not, the parameters
             * that were sent are the right ones to send again.
             */
            var params = text(json.stitcherParams);
            if (params.charAt(0) === "?") {
                params = params.substring(1);
            }
            if (!params) {
                params = query(bootParams());
            }

            session = {
                token: token,
                params: params,
                stitcher: text(get(json, "servers.stitcher")) ||
                    STITCHER_FALLBACK,
                region: text(claims.activeRegion) || text(claims.country) || "",
                city: text(claims.city),
                language: text(claims.preferredLanguage),
                expires: (claims.exp || 0) * 1000
            };
            sessionAt = Date.now();
            lastError = null;
            return session;
        });
    }

    /*
     * The session, minting one if what is held has expired.
     *
     * Everything else goes through here, so a run of shelves loading at once
     * shares one boot rather than each asking for a token of its own.
     */
    function authorize() {
        if (session) {
            var expiry = session.expires ||
                (sessionAt + 60 * 60 * 1000);
            if (Date.now() < expiry - 60000) {
                return Promise.resolve(session);
            }
        }
        if (pending) {
            return pending;
        }

        pending = boot()["catch"](function (err) {
            lastError = err;
            throw err;
        }).then(function (s) {
            pending = null;
            return s;
        }, function (err) {
            pending = null;
            throw err;
        });

        return pending;
    }

    // A GET against one of the JSON services, with the session token attached.
    function api(base, path, params) {
        return authorize().then(function (s) {
            var url = base + path;
            var q = query(params || {});
            if (q) {
                url += (url.indexOf("?") < 0 ? "?" : "&") + q;
            }

            return fetch(url, {
                method: "GET",
                headers: {
                    "Accept": "application/json",
                    "Authorization": "Bearer " + s.token
                }
            }).then(function (res) {
                if (res.status === 401 || res.status === 403) {
                    // The token went stale early, or the region moved under
                    // us. Drop it so the next call boots again.
                    session = null;
                    throw new Error("Pluto rejected the session (" +
                                    res.status + ")");
                }
                if (!res.ok) {
                    throw new Error("Pluto answered " + res.status);
                }
                return res.json();
            });
        });
    }

    /* ------------------------------------------------------------- images */

    function absUrl(u) {
        u = text(u);
        if (!u) {
            return "";
        }
        if (u.indexOf("//") === 0) {
            return "https:" + u;
        }
        if (u.charAt(0) === "/") {
            return IMAGE_HOST + u;
        }
        return u;
    }

    /*
     * Cards are 16:9, so that is what to look for first.
     *
     * Pluto describes its artwork three different ways depending on which
     * service answered -- a list of covers with aspect ratios, a set of named
     * fields, or a list of typed images -- and a title may carry any of them.
     * Try each shape rather than guessing which service this object came from.
     */
    function pickImage(obj) {
        if (!obj) {
            return "";
        }

        var covers = obj.covers;
        var i;
        if (covers && covers.length) {
            for (i = 0; i < covers.length; i++) {
                if (text(covers[i].aspectRatio) === "16:9") {
                    return absUrl(covers[i].url || covers[i].path);
                }
            }
        }

        var named = [
            "poster16_9.path", "featuredImage.path", "tile.path",
            "thumbnail.path", "poster.path", "logo.path", "colorLogoPNG.path"
        ];
        for (i = 0; i < named.length; i++) {
            var hit = get(obj, named[i]);
            if (hit) {
                return absUrl(hit);
            }
        }

        // The channels service returns a typed list instead.
        var images = obj.images;
        if (images && images.length) {
            var want = ["featuredImage", "tile", "thumbnail", "colorLogoPNG",
                        "solidLogoPNG", "logo"];
            var j;
            for (j = 0; j < want.length; j++) {
                for (i = 0; i < images.length; i++) {
                    if (text(images[i].type) === want[j]) {
                        return absUrl(images[i].url || images[i].path);
                    }
                }
            }
            return absUrl(images[0].url || images[0].path);
        }

        if (covers && covers.length) {
            return absUrl(covers[0].url || covers[0].path);
        }
        return "";
    }

    /* -------------------------------------------------------- descriptions */

    function durationText(ms) {
        var mins = Math.round((ms || 0) / 60000);
        if (mins <= 0) {
            return "";
        }
        if (mins < 60) {
            return mins + " min";
        }
        var h = Math.floor(mins / 60);
        var m = mins % 60;
        return m ? h + " h " + m + " min" : h + " h";
    }

    function clockText(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) {
            return "";
        }
        var m = d.getMinutes();
        return d.getHours() + ":" + (m < 10 ? "0" : "") + m;
    }

    function describe(parts) {
        return parts.filter(function (p) {
            return !!text(p);
        }).join(" · ");
    }

    /*
     * Where a playable thing's manifest lives.
     *
     * Items carry their own stitcher path, and using the one that came with
     * the item is better than assembling a guess from its id: it is what the
     * service means by "play this", and it is already correct for the odd
     * title whose media id is not its item id. resolve() falls back to
     * building one only when an item arrived without a path -- which is what
     * happens to anything reached from a listing that does not carry them.
     */
    var paths = {};

    function rememberPath(id, obj) {
        var stitched = obj && obj.stitched;
        if (!stitched) {
            return;
        }

        var found = "";
        var list = stitched.paths || stitched.urls || [];
        var i;
        for (i = 0; i < list.length; i++) {
            var candidate = text(list[i].path || list[i].url);
            var kind = text(list[i].type);
            if (candidate && (!kind || kind === "hls")) {
                found = candidate;
                break;
            }
        }
        if (!found) {
            found = text(stitched.path);
        }
        if (found) {
            paths[id] = found;
        }
    }

    /* ------------------------------------------------------------ entries */

    /*
     * A live channel.
     *
     * The description is what is on now, which is the thing a viewer scanning
     * a wall of channel logos actually wants; the channel's own summary is a
     * sentence about the channel and says nothing about what is playing.
     */
    function entryOfChannel(item) {
        var id = text(item._id || item.id);
        var timelines = item.timelines || [];
        var now = timelines.length ? timelines[0] : null;
        var number = item.number;

        rememberPath("channel:" + id, item);

        var showing = "";
        if (now) {
            showing = describe([
                clockText(now.start),
                text(now.title) || text(get(now, "episode.name"))
            ]);
        }

        return {
            id: "channel:" + id,
            name: (number ? number + ". " : "") + text(item.name),
            description: showing || text(item.summary),
            image: pickImage(item),
            type: "video",
            live: true,
            paid: false
        };
    }

    // An on-demand title: a film, or a series to open.
    // Pluto labels a title's type, but not always: some carry only a list of
    // season numbers, and having seasons is what makes something a show.
    function isSeries(item) {
        return text(item.type) === "series" ||
            !!(item.seasonsNumbers && item.seasonsNumbers.length > 0);
    }

    function entryOfVod(item) {
        var id = text(item._id || item.id);

        if (isSeries(item)) {
            var seasons = (item.seasonsNumbers || []).length;
            return {
                id: "series:" + id,
                name: text(item.name),
                description: describe([
                    text(item.genre),
                    seasons ? seasons + (seasons === 1 ? " season" : " seasons")
                        : ""
                ]) || text(item.summary),
                image: pickImage(item),
                type: "folder",
                live: false,
                paid: false
            };
        }

        rememberPath("episode:" + id, item);

        return {
            id: "episode:" + id,
            name: text(item.name),
            description: describe([
                text(item.genre),
                durationText(item.duration),
                text(item.rating)
            ]) || text(item.summary),
            image: pickImage(item),
            type: "video",
            live: false,
            paid: false
        };
    }

    // An episode inside a season.
    function entryOfEpisode(item, seasonNumber) {
        var id = text(item._id || item.id);
        rememberPath("episode:" + id, item);

        var number = item.number;
        var season = item.season || seasonNumber;
        var label = "";
        if (season && number) {
            label = "S" + season + "E" + number;
        } else if (number) {
            label = "Episode " + number;
        }

        return {
            id: "episode:" + id,
            name: (label ? label + " – " : "") + text(item.name),
            description: describe([
                durationText(item.duration),
                text(item.description) || text(item.summary)
            ]),
            image: pickImage(item),
            type: "video",
            live: false,
            paid: false
        };
    }

    function entryOfCategory(item) {
        var id = text(item._id || item.id);
        var count = item.totalItemsCount || (item.items || []).length;

        return {
            id: "cat:" + id,
            name: text(item.name),
            description: count ? count + (count === 1 ? " title" : " titles") : "",
            image: pickImage(item) || pickImage((item.items || [])[0]),
            type: "folder",
            live: false,
            paid: false
        };
    }

    function entryOfSeason(seriesId, seasonNumber, count) {
        return {
            id: "season:" + seriesId + ":" + seasonNumber,
            name: "Season " + seasonNumber,
            description: count ? count + (count === 1 ? " episode" : " episodes")
                : "",
            image: "",
            type: "folder",
            live: false,
            paid: false
        };
    }

    /* ----------------------------------------------------------- channels */

    /*
     * The whole live lineup, with what each channel is showing.
     *
     * api.pluto.tv answers with the lineup and its programme data together
     * when given a window, which is one request rather than a lineup followed
     * by a schedule lookup per hundred channels. The channels service is asked
     * only if that fails: it returns the same channels in a different shape,
     * and is worth having as a second door rather than a first.
     */
    function fetchChannels() {
        var start = new Date();
        var stop = new Date(start.getTime() + EPG_WINDOW_MIN * 60000);

        return api(API, "/v2/channels", {
            start: start.toISOString(),
            stop: stop.toISOString()
        }).then(function (json) {
            var list = json && json.length ? json : (json && json.data) || [];
            if (!list.length) {
                throw new Error("Empty channel list");
            }
            return list;
        })["catch"](function (err) {
            return api(CHANNELS_API, "/v2/guide/channels", {
                start: start.toISOString(),
                stop: stop.toISOString(),
                offset: 0,
                limit: 1000,
                sort: "number:asc"
            }).then(function (json) {
                var list = (json && json.data) || json || [];
                if (!list.length) {
                    throw err;
                }
                return list;
            });
        });
    }

    function channels() {
        return cached("channels", fetchChannels, CHANNEL_TTL_MS);
    }

    // Pluto's own category name for a channel, under whichever key the service
    // that answered happens to use.
    function categoryOf(channel) {
        var name = text(channel.category) ||
            text(get(channel, "categories.0.name")) ||
            text(channel.genre);
        return name || "Other";
    }

    function isRealChannel(channel) {
        // Number zero is Pluto's own promotional filler rather than something
        // a viewer picked, and hidden channels are exactly that.
        if (channel.visibility && text(channel.visibility) === "hidden") {
            return false;
        }
        return text(channel._id || channel.id) !== "";
    }

    // Every channel, in lineup order, as one flat list.
    function allChannels() {
        return channels().then(function (list) {
            return list.filter(isRealChannel).map(entryOfChannel);
        });
    }

    // The channels of one category, named as Pluto names it.
    function channelsIn(category) {
        return channels().then(function (list) {
            return list.filter(function (c) {
                return isRealChannel(c) &&
                    (category === "*" || categoryOf(c) === category);
            }).map(entryOfChannel);
        });
    }

    /*
     * Kanaler: a shelf per category, in the order the lineup presents them.
     *
     * The rows are named rather than fetched, since one channels() answer
     * feeds all of them -- panel() below reads it back out of the cache.
     */
    function livePanels() {
        return channels().then(function (list) {
            var seen = {};
            var rows = [];

            list.filter(isRealChannel).forEach(function (c) {
                var name = categoryOf(c);
                if (seen[name]) {
                    seen[name].count++;
                    return;
                }
                seen[name] = {count: 1};
                rows.push({
                    name: name,
                    panelId: name,
                    kind: "channels"
                });
            });

            rows.forEach(function (r) {
                var n = seen[r.name].count;
                r.detail = n + (n === 1 ? " channel" : " channels");
            });

            return {title: "Live TV", rows: rows};
        });
    }

    /* ---------------------------------------------------------- on demand */

    /*
     * The on-demand catalogue.
     *
     * Asking for the items inline makes this one request instead of one per
     * category, and it is the same request the home page is built from, so
     * everything on-demand costs a single call the first time and nothing
     * afterwards.
     */
    function fetchVodCategories() {
        return api(API, "/v3/vod/categories", {
            includeItems: "true",
            deviceType: DEVICE_TYPE,
            offset: 0,
            limit: 1000
        }).then(function (json) {
            var list = (json && json.categories) || [];
            return list.filter(function (c) {
                return (c.items || []).length > 0;
            });
        });
    }

    function vodCategories() {
        return cached("vod", fetchVodCategories);
    }

    function categories() {
        return vodCategories().then(function (list) {
            return list.map(entryOfCategory);
        });
    }

    /*
     * The catalogue, split the way Pluto's own navigation splits it.
     *
     * Films and shows are mixed together inside each category, so Movies and
     * Shows are the same rows filtered two ways rather than two different
     * requests -- and a category with nothing of the kind being asked for
     * drops out rather than drawing an empty shelf.
     */
    function vodItemsOfKind(items, kind) {
        return (items || []).filter(function (item) {
            return isSeries(item) === (kind === "shows");
        });
    }

    function vodRows(kind) {
        return vodCategories().then(function (list) {
            var rows = [];
            list.forEach(function (c) {
                var n = vodItemsOfKind(c.items, kind).length;
                if (!n) {
                    return;
                }
                rows.push({
                    name: text(c.name),
                    detail: n + (n === 1 ? " title" : " titles"),
                    panelId: text(c._id || c.id),
                    kind: kind
                });
            });
            return rows;
        });
    }

    function categoryItemsOfKind(id, kind) {
        return vodCategories().then(function (list) {
            var i;
            for (i = 0; i < list.length; i++) {
                if (text(list[i]._id || list[i].id) === id) {
                    return vodItemsOfKind(list[i].items, kind).map(entryOfVod);
                }
            }
            throw new Error("Unknown category");
        });
    }

    function categoryItems(id) {
        return vodCategories().then(function (list) {
            var i;
            for (i = 0; i < list.length; i++) {
                if (text(list[i]._id || list[i].id) === id) {
                    return (list[i].items || []).map(entryOfVod);
                }
            }
            throw new Error("Unknown category");
        });
    }

    /*
     * A series, as its seasons.
     *
     * The response carries every episode of every season, so the season list
     * and the episodes behind it come out of one request -- which is why
     * season() takes the series id along with the number rather than a season
     * id of its own.
     */
    function fetchSeries(seriesId) {
        return api(API, "/v3/vod/series/" + encodeURIComponent(seriesId) +
                   "/seasons", {
                       includeItems: "true",
                       deviceType: DEVICE_TYPE
                   });
    }

    function seriesData(seriesId) {
        return cached("series:" + seriesId, function () {
            return fetchSeries(seriesId);
        });
    }

    function series(seriesId) {
        return seriesData(seriesId).then(function (json) {
            var seasons = (json && json.seasons) || [];

            var head = {
                name: text(json.name),
                description: text(json.summary) || text(json.description),
                image: pickImage(json)
            };

            var entries = seasons.map(function (s) {
                return entryOfSeason(seriesId, s.number,
                                     (s.episodes || []).length);
            });

            return {head: head, entries: entries};
        });
    }

    function season(seriesId, number) {
        return seriesData(seriesId).then(function (json) {
            var seasons = (json && json.seasons) || [];
            var i;
            for (i = 0; i < seasons.length; i++) {
                if (String(seasons[i].number) === String(number)) {
                    return (seasons[i].episodes || []).map(function (e) {
                        return entryOfEpisode(e, seasons[i].number);
                    });
                }
            }
            throw new Error("Unknown season");
        });
    }

    /* ------------------------------------------------------------- search */

    /*
     * Search covers both halves of the service at once, so a result may be a
     * channel, a film or a series. What comes back is shaped like a VOD item
     * except for channels, which are recognised by their type.
     */
    function search(term) {
        term = text(term);
        if (!term) {
            return Promise.resolve([]);
        }

        return cached("search:" + term.toLowerCase(), function () {
            return api(SEARCH_API, "", {
                q: term,
                limit: SEARCH_LIMIT
            }).then(function (json) {
                var list = (json && (json.data || json.results ||
                                     json.items)) || json || [];
                if (!list.length) {
                    return [];
                }
                return list.map(function (item) {
                    var type = text(item.type);
                    if (type === "channel" || type === "live") {
                        return entryOfChannel(item);
                    }
                    return entryOfVod(item);
                });
            });
        });
    }

    /* --------------------------------------------------------------- home */

    /*
     * The home page.
     *
     * Pluto has no editorial "start page" endpoint to point at, which is a
     * mercy: there are no opaque row ids here to go stale. The rows are the
     * live lineup followed by the first few on-demand categories, in the order
     * Pluto itself returns them, so a reshuffle of the catalogue turns up here
     * on its own.
     */
    var HOME_CATEGORIES = 4;

    function startRows() {
        return Promise.all([
            channels()["catch"](function () { return []; }),
            vodCategories()["catch"](function () { return []; })
        ]).then(function (results) {
            var chans = results[0];
            var cats = results[1];
            var rows = [];

            if (chans.length) {
                rows.push({
                    name: "Live TV",
                    detail: chans.length + " channels",
                    panelId: "*",
                    kind: "channels"
                });
            }

            cats.slice(0, HOME_CATEGORIES).forEach(function (c) {
                rows.push({
                    name: text(c.name),
                    detail: "",
                    panelId: text(c._id || c.id),
                    kind: "category"
                });
            });

            return rows;
        });
    }

    // What a shelf on a page of shelves resolves to.
    function panel(id, kind) {
        if (kind === "channels") {
            return channelsIn(id);
        }
        if (kind === "movies" || kind === "shows") {
            return categoryItemsOfKind(id, kind);
        }
        if (kind === "category") {
            return categoryItems(id);
        }
        return Promise.reject(new Error("Unknown row: " + kind));
    }

    /* ----------------------------------------------------------- playback */

    /*
     * A manifest URL for something playable.
     *
     * There is no request behind this: the stitcher takes the id, the device
     * description and the session token in the URL itself and answers with the
     * manifest. Which is why an expired token surfaces here as a failure to
     * load rather than as an error with a message, and why authorize() is
     * asked for a live one first.
     *
     * masterJWTPassthrough carries the token down into the variant playlists,
     * so the player can follow them without re-signing anything.
     */
    /*
     * Normalise whatever the catalogue handed out into a bare path.
     *
     * The values differ by service and by age: some are relative
     * ("/stitch/hls/..."), some absolute and pointing at a stitcher host that
     * is no longer the one this session was given, and some already carry a
     * version prefix and a query string of their own. Only the path below the
     * version is worth keeping -- the host, the version and the query all come
     * from the live session instead.
     */
    function stitchPath(path) {
        var p = text(path);

        // Drop scheme and host: the session names the stitcher to use, and a
        // host baked into a catalogue entry may be a retired one.
        p = p.replace(/^https?:\/\/[^/]+/, "");

        // Drop any query the catalogue attached; it holds a stale session.
        p = p.split("?")[0];

        if (p.charAt(0) !== "/") {
            p = "/" + p;
        }

        // Strip whatever version is on it, so exactly one can be put back.
        p = p.replace(/^\/v\d+(?=\/)/, "");

        return "/v2" + p;
    }

    /*
     * The manifest URL.
     *
     * Everything below /v2 on the stitcher named by this session, with the
     * session's own parameters. Asking the v1 stitcher, or asking v2 without
     * the full parameter set, is answered with a manifest that plays a slate
     * saying Pluto is no longer available on this device -- an ordinary,
     * playable stream, so it fails as wrong content rather than as an error.
     *
     * includeExtendedEvents belongs to that parameter set. It reads like a
     * request for richer metadata and not like a gate on playback, but the
     * clients that work send it and the ones that do not get the slate.
     *
     * masterJWTPassthrough carries the token down into the variant playlists,
     * so the player can follow them without re-signing anything.
     */
    function stitchUrl(s, path) {
        return s.stitcher + stitchPath(path) + "?" + s.params +
            "&jwt=" + encodeURIComponent(s.token) +
            "&masterJWTPassthrough=true" +
            "&includeExtendedEvents=true";
    }

    function resolve(id) {
        id = text(id);

        return authorize().then(function (s) {
            var path = paths[id];

            if (!path) {
                // Nothing was carried with the item, so address it by id.
                if (id.indexOf("channel:") === 0) {
                    path = "/stitch/hls/channel/" +
                        encodeURIComponent(id.substring(8)) + "/master.m3u8";
                } else if (id.indexOf("episode:") === 0) {
                    path = "/stitch/hls/episode/" +
                        encodeURIComponent(id.substring(8)) + "/master.m3u8";
                } else {
                    throw new Error("Nothing to play for " + id);
                }
            }

            var url = stitchUrl(s, path);

            if (window.console) {
                console.log("playing hls: " + url);
            }

            return {
                url: url,
                kind: "hls",
                format: "hls",
                drm: null
            };
        });
    }

    return {
        startRows: startRows,
        panel: panel,
        livePanels: livePanels,
        categories: categories,
        categoryItems: categoryItems,
        vodRows: vodRows,
        allChannels: allChannels,
        series: series,
        season: season,
        search: search,
        resolve: resolve,
        clearCache: clearCache,

        // Status reads these; nothing else needs the session itself.
        session: function () { return session; },
        refresh: function () {
            session = null;
            return authorize();
        },
        lastError: function () {
            return lastError ? lastError.message : "";
        }
    };
}());
