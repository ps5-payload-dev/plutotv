/*
 * The application: a browsing shell and a player, and a navigation stack of
 * one between them.
 *
 * Everything the viewer can reach is a "frame" -- a view name plus a parameter
 * -- pushed onto a stack. Circle pops it. Frames remember which card was
 * focused, so backing out of a series puts the cursor back on that series.
 * Listings are re-fetched on the way back rather than kept as live DOM, which
 * is what the cache in pluto.js is for.
 */
(function () {
    "use strict";

    var K = Input.KEY;

    var elCrumb   = document.getElementById("crumb");
    var elClock   = document.getElementById("clock");
    var elRail    = document.getElementById("rail");
    var elContent = document.getElementById("content");
    var elLoad    = document.getElementById("loadbar");
    var elToast   = document.getElementById("toast");

    var elPlayer  = document.getElementById("player");
    var video     = document.getElementById("video");
    var elOsd     = document.getElementById("osd");
    var elSpinner = document.getElementById("spinner");

    var elName    = document.getElementById("osd-name");
    var elDesc    = document.getElementById("osd-desc");
    var elState   = document.getElementById("osd-state");
    var elFill    = document.getElementById("osd-fill");
    var elHead    = document.getElementById("osd-head");
    var elPos     = document.getElementById("osd-pos");
    var elDur     = document.getElementById("osd-dur");
    var elTech    = document.getElementById("osd-tech");

    // Cards are cheap but not free, and a category can hold a couple of
    // hundred titles. Draw a screenful, then extend as the cursor nears the end.
    var CHUNK = 40;
    var GROW_MARGIN = 12;

    /*
     * The same views pluto.tv puts in its own header, in its order, plus the
     * two this UI needs of its own: Search, which the site keeps behind an
     * icon, and Status, which has no equivalent because a browser does not
     * have to be told which region it resolved to.
     */
    var RAIL = [
        {id: "start",   name: "Home"},
        {id: "live",    name: "Live TV"},
        {id: "movies",  name: "Movies"},
        {id: "shows",   name: "Shows"},
        {id: "search",  name: "Search"},
        {id: "status",  name: "Status"}
    ];

    // Focus indices are counted within the listing only; the nav rail is
    // reachable by pressing Left but is never part of a saved position.
    var SCOPE = elContent;

    var stack = [];
    var token = 0;          // guards against a slow fetch overwriting a new view
    var entries = [];       // what the current listing is showing
    var drawn = 0;
    var gridEl = null;
    var mode = "browse";    // browse | player

    // True while the cursor is sitting in the nav rail. Opening a rail item
    // loads its view but leaves the cursor on the menu, so the viewer can run
    // down Home / Live TV / Movies and see each one without being thrown
    // into the listing; Right (or Cross on a card) is what hands focus over.
    var railLock = false;

    /* ------------------------------------------------------------ helpers */

    function esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function busy(on) {
        elLoad.className = on ? "on" : "";
    }

    var toastTimer = null;
    function toast(msg, isError) {
        elToast.textContent = msg;
        elToast.className = isError ? "error" : "";
        elToast.hidden = false;
        if (toastTimer) {
            clearTimeout(toastTimer);
        }
        toastTimer = setTimeout(function () {
            elToast.hidden = true;
        }, 3200);
    }

    function tickClock() {
        var d = new Date();
        var m = d.getMinutes();
        elClock.textContent = d.getHours() + ":" + (m < 10 ? "0" : "") + m;
    }

    /* -------------------------------------------------------------- icons */

    var ICON = {
        play:   '<path d="M6 3.5L17.5 10 6 16.5z"/>',
        folder: '<path d="M2 4.5h6l1.6 2H18v9.5H2z"/>'
    };

    function icon(name) {
        return '<svg class="icon" viewBox="0 0 20 20" width="1em" height="1em" ' +
            'fill="currentColor" aria-hidden="true" focusable="false">' +
            ICON[name] + "</svg>";
    }

    function fmtTime(t) {
        if (!isFinite(t) || t < 0) {
            return "--:--";
        }
        t = Math.floor(t);
        var h = Math.floor(t / 3600);
        var m = Math.floor((t % 3600) / 60);
        var s = t % 60;
        function pad(n) { return (n < 10 ? "0" : "") + n; }
        return h ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
    }

    /* -------------------------------------------------------------- cards */

    function cardHtml(entry, i) {
        var thumb = entry.image
            ? '<img src="' + esc(entry.image) + '" alt="" ' +
            'onerror="this.style.display=\'none\'">'
            : '<span class="glyph">' +
            icon(entry.type === "folder" ? "folder" : "play") + "</span>";

        // Pluto is free throughout, so there is no premium badge to draw --
        // entry.paid is kept only so a card renders the same either way.
        var badge = "";
        if (entry.live) {
            badge = '<span class="badge">Live</span>';
        } else if (entry.type === "folder") {
            badge = '<span class="badge folder">' + icon("folder") + "</span>";
        }
        if (entry.paid) {
            badge += '<span class="badge paid">Premium</span>';
        }

        return '<div class="card focusable" data-i="' + i + '">' +
            '<div class="thumb">' + thumb + badge + "</div>" +
            '<div class="meta">' +
            '<div class="name">' + esc(entry.name) + "</div>" +
            '<div class="desc">' + esc(entry.description || "") + "</div>" +
            "</div></div>";
    }

    function drawChunk() {
        if (!gridEl || drawn >= entries.length) {
            return;
        }
        var end = Math.min(entries.length, drawn + CHUNK);
        var html = "";
        for (var i = drawn; i < end; i++) {
            html += cardHtml(entries[i], i);
        }
        gridEl.insertAdjacentHTML("beforeend", html);
        drawn = end;
    }

    // Called on every focus change: keep at least GROW_MARGIN cards drawn ahead
    // of the cursor so running down a long list never hits a wall.
    Input.setFocusListener(function (el) {
        if (!el || !el.getAttribute) {
            return;
        }

        // The cursor is the only thing that decides whether the menu holds it.
        var rail = el.getAttribute("data-rail");
        railLock = !!rail;

        // Focusing a rail item is what opens it: the listing on the right
        // follows the cursor down the menu with no Cross needed.
        if (rail) {
            activateRail(rail);
        }

        if (!gridEl) {
            return;
        }
        var i = parseInt(el.getAttribute("data-i"), 10);
        if (!isNaN(i) && i > drawn - GROW_MARGIN) {
            drawChunk();
        }
    });

    // Every "put the cursor somewhere in the listing" goes through these two, so
    // that a view loaded from the menu cannot steal it back.
    function focusContent(i) {
        if (railLock) {
            return;
        }
        Input.focusIndex(i, SCOPE);
    }

    // Nothing in the listing to put the cursor on -- it is empty, or it
    // failed -- so the menu takes it. The item this view belongs to, not the
    // first one: focusing a rail item is what opens the view behind it, so
    // landing on Hem would quietly walk the viewer back there a fifth of a
    // second later.
    function focusFallback() {
        if (railLock) {
            return;
        }
        focusRail();
    }

    function notice(title, body, isError) {
        elContent.innerHTML = '<div class="notice' +
            (isError ? " error" : "") + '"><b>' + esc(title) + "</b>" +
            esc(body || "") + "</div>";
        gridEl = null;
        entries = [];
    }

    function listing(list, opts) {
        opts = opts || {};
        entries = list;
        drawn = 0;

        if (!list.length) {
            notice("Empty", "There is nothing in this list right now.");
            focusFallback();
            return;
        }

        elContent.innerHTML = (opts.head || "") +
            '<div class="grid" id="grid"></div>';
        gridEl = document.getElementById("grid");
        drawChunk();

        // A remembered position may sit past the first chunk.
        var want = opts.focus == null ? 0 : opts.focus;
        while (drawn <= want && drawn < list.length) {
            drawChunk();
        }
        focusContent(want);
        settleHead();
    }

    /*
     * The header image has no size until it arrives, so the geometry that
     * reveal() just measured was the layout without it. When it lands, every
     * card below moves down by its height and the scroll position that had
     * been correct now points at a gap -- the cursor is on a card that is no
     * longer on screen, which reads as a listing that failed to draw. Measure
     * again once the image has settled it.
     */
    function settleHead() {
        var img = elContent.querySelector(".showhead img");
        if (!img || img.complete) {
            return;
        }
        function again() {
            img.onload = null;
            img.onerror = null;
            var cur = Input.current(SCOPE);
            if (cur) {
                Input.reveal(cur);
            }
        }
        img.onload = again;
        img.onerror = again;
    }

    /* --------------------------------------------------------------- rail */

    // The rail is rebuilt on every render, so the focus ring goes with the old
    // nodes. Remember which item had it and put it back on the new node; the
    // return value says whether the cursor is still in the menu, and is what
    // stops the fresh listing from grabbing it.
    function drawRail(currentView) {
        var focused = elRail.querySelector(".rail-item.focused");
        var keep = focused ? focused.getAttribute("data-rail") : null;

        elRail.innerHTML = RAIL.map(function (r) {
            return '<div class="rail-item focusable' +
                (r.id === currentView ? " current" : "") +
                '" data-rail="' + r.id + '">' + esc(r.name) + "</div>";
        }).join("");

        if (keep) {
            Input.focus(elRail.querySelector(
                '.rail-item[data-rail="' + keep + '"]'
            ));
            return true;
        }
        return false;
    }

    // Is the cursor in the menu right now? Asked of the DOM rather than kept in
    // a flag, because railLock answers a different question -- whether a listing
    // that arrives late is allowed to take the cursor.
    function inRail() {
        var el = Input.current();
        return !!(el && el.getAttribute && el.getAttribute("data-rail"));
    }

    // Which rail entry a view belongs under. Read from the root frame, so
    // drilling into a series from Search keeps Search lit rather than falling
    // back to Home.
    function railIdOf(view) {
        if (view === "live" || view === "channels") {
            return "live";
        }
        if (view === "movies") {
            return "movies";
        }
        if (view === "shows") {
            return "shows";
        }
        if (view === "search") {
            return "search";
        }
        if (view === "status") {
            return "status";
        }
        return "start";
    }

    function currentRoot() {
        return stack.length ? railIdOf(stack[0].view) : "start";
    }

    function focusRail() {
        Input.focus(elRail.querySelector(".rail-item.current") ||
                    elRail.querySelector(".rail-item"));
    }

    /*
     * Opening on focus means a held D-pad would fire a request per item on the
     * way past, so wait for the cursor to settle first. Anything that hands the
     * cursor to the listing flushes the pending load, so Right never lands in
     * the previous view's cards.
     */
    var RAIL_DELAY = 220;
    var railTimer = null;
    var railPending = null;

    function cancelRail() {
        if (railTimer) {
            clearTimeout(railTimer);
            railTimer = null;
        }
        railPending = null;
    }

    function activateRail(id) {
        cancelRail();

        // Already showing it -- including the redraw that render() itself does,
        // which re-focuses this very item and would otherwise loop.
        if (!id || id === currentRoot()) {
            return;
        }

        railPending = id;
        railTimer = setTimeout(function () {
            railTimer = null;
            openRail(railPending);
        }, RAIL_DELAY);
    }

    function flushRail() {
        if (!railTimer) {
            return;
        }
        clearTimeout(railTimer);
        railTimer = null;
        openRail(railPending);
    }

    function openRail(id) {
        railPending = null;
        if (!id || id === currentRoot()) {
            return;
        }
        stack = [frameOf(id, null, null)];
        render(stack[0]);
    }

    // Hand the cursor from the menu to the listing. railLock is dropped first
    // so that a view still loading places the cursor when it arrives.
    function enterContent() {
        flushRail();
        railLock = false;
        var top = stack[stack.length - 1];
        Input.focusIndex(top ? top.focus : 0, SCOPE);
    }

    /* -------------------------------------------------------------- views */

    function crumb(parts) {
        elCrumb.innerHTML = parts.map(function (p, i) {
            return (i ? "<i>›</i>" : "") +
                (i === parts.length - 1 ? "<b>" + esc(p) + "</b>" : esc(p));
        }).join("");
    }

    function frameOf(view, param, title) {
        return {view: view, param: param, title: title, focus: 0};
    }

    function go(frame) {
        var top = stack[stack.length - 1];
        if (top) {
            top.focus = Math.max(0, Input.indexOfFocused(SCOPE));
        }
        stack.push(frame);
        render(frame);
    }

    function back() {
        if (stack.length < 2) {
            // Nothing to pop: treat Circle as "take me to the menu", landing on
            // the entry this view belongs to rather than on the first one.
            var top = stack[stack.length - 1];
            if (top) {
                top.focus = Math.max(0, Input.indexOfFocused(SCOPE));
            }
            focusRail();
            return;
        }
        stack.pop();
        render(stack[stack.length - 1]);
    }

    function render(frame) {
        var my = ++token;
        railLock = drawRail(currentRoot());
        gridEl = null;
        entries = [];
        drawn = 0;
        busy(true);

        function fresh() {
            return my === token;
        }

        function fail(err) {
            if (!fresh()) { return; }
            busy(false);
            notice("Could not load the list",
                   (err && err.message) || String(err), true);
            focusFallback();
        }

        function done(list, head) {
            if (!fresh()) { return; }
            busy(false);
            listing(list, {head: head, focus: frame.focus});
        }

        if (frame.view === "start") {
            crumb(["Home"]);
            Pluto.startRows().then(function (rows) {
                if (!fresh()) { return; }
                renderShelves(my, rows);
            }, fail);
            return;
        }

        if (frame.view === "live") {
            crumb(["Live TV"]);
            Pluto.livePanels().then(function (page) {
                if (!fresh()) { return; }
                renderShelves(my, page.rows);
            }, fail);
            return;
        }

        if (frame.view === "movies" || frame.view === "shows") {
            crumb([frame.view === "movies" ? "Movies" : "Shows"]);
            Pluto.vodRows(frame.view).then(function (rows) {
                if (!fresh()) { return; }
                renderShelves(my, rows);
            }, fail);
            return;
        }

        if (frame.view === "status") {
            crumb(["Status"]);
            busy(false);
            renderStatus(my);
            return;
        }

        if (frame.view === "search") {
            crumb(["Search"]);
            busy(false);
            renderSearch(my, frame.param);
            return;
        }

        if (frame.view === "category") {
            crumb([frame.title]);
            Pluto.categoryItems(frame.param).then(function (l) {
                done(l);
            }, fail);
            return;
        }

        if (frame.view === "channels") {
            crumb(["Live TV", frame.title]);
            Pluto.panel(frame.param, "channels").then(function (l) {
                done(l);
            }, fail);
            return;
        }

        if (frame.view === "series") {
            crumb(["Shows", frame.title]);
            Pluto.series(frame.param).then(function (res) {
                if (!fresh()) { return; }
                var h = res.head;
                var head = "";
                if (h && (h.name || h.description)) {
                    head = '<div class="showhead">' +
                        (h.image ? '<img src="' + esc(h.image) +
                         '" alt="" onerror="this.style.display=\'none\'">' : "") +
                        '<div class="txt"><h2>' + esc(h.name || frame.title) +
                        "</h2><p>" + esc(h.description || "") + "</p></div></div>";
                    crumb(["Shows", h.name || frame.title]);
                }

                // A single season is not worth a folder of its own: step
                // through it and show the episodes directly.
                var only = res.entries.length === 1 ? res.entries[0] : null;
                if (only && only.id.indexOf("season:") === 0) {
                    var ref = seasonRef(only.id);
                    Pluto.season(ref.series, ref.number).then(function (list) {
                        done(list, head);
                    }, fail);
                    return;
                }

                done(res.entries, head);
            }, fail);
            return;
        }

        if (frame.view === "season") {
            crumb(["Shows", frame.title]);
            Pluto.season(frame.param.series, frame.param.number)
                .then(function (l) { done(l); }, fail);
            return;
        }

        fail(new Error("unknown view: " + frame.view));
    }

    /*
     * The status screen.
     *
     * There is no account to manage: Pluto is free and asks for nothing but a
     * device id, which this generates once and keeps. What is worth showing
     * instead is what the session came back as -- above all the region, since
     * that is decided by the address the console connects from, and is the
     * first thing to look at when the catalogue is not the expected one.
     */
    function renderStatus(my) {
        elContent.innerHTML =
            '<div class="account">' +
            '<div class="status" id="sess-status"><b>Fetching session…</b></div>' +
            "<p>Pluto TV is free and needs no sign-in. The region follows from " +
            "the address the console connects from, and decides both the " +
            "channel lineup and the catalogue.</p>" +
            '<div class="action focusable" data-action="refresh">' +
            "Renew the session</div>" +
            '<div class="action focusable" data-action="reload">' +
            "Clear the cache and reload</div>" +
            '<div class="drm" id="sess-note"></div>' +
            "</div>";

        gridEl = null;
        entries = [];
        focusContent(frame_focus());

        Pluto.refresh().then(function (info) {
            if (my !== token) { return; }
            var box = document.getElementById("sess-status");
            var note = document.getElementById("sess-note");
            if (!box) { return; }

            box.innerHTML = '<b class="on">Ansluten' +
                (info.region ? " – " + esc(info.region.toUpperCase()) : "") +
                "</b><span>" +
                (info.city ? esc(info.city) + ". " : "") +
                (info.expires
                 ? "Session valid until " +
                 esc(new Date(info.expires).toLocaleTimeString())
                 : "Could not read how long the session is valid.") +
                "</span>";

            if (note) {
                note.textContent = "Streams come from " +
                    info.stitcher.replace(/^https?:\/\//, "") + ".";
            }
        }, function (err) {
            if (my !== token) { return; }
            var box = document.getElementById("sess-status");
            if (!box) { return; }
            box.innerHTML = '<b class="off">No session</b><span>' +
                esc((err && err.message) || "Unknown error") + "</span>";
        });
    }

    /*
     * Search.
     *
     * Typing on a pad is miserable, so the field is left to the system
     * keyboard and Input steps aside for as long as it has focus. The term
     * belongs to the frame rather than to the field, so opening a result and
     * backing out of it shows the same results again rather than an empty box.
     */
    function renderSearch(my, term) {
        elContent.innerHTML =
            '<div class="account">' +
            '<div class="status"><b>Search</b><span>' +
            (term ? "Results for \u201d" + esc(term) + "\u201d."
             : "Channels, movies and shows.") +
            "</span></div>" +
            '<textarea id="searchbox" rows="1" spellcheck="false" ' +
            'autocapitalize="off" autocorrect="off" hidden></textarea>' +
            '<div class="action focusable" data-action="search">' +
            (term ? "Search again" : "Enter a search term") + "</div>" +
            '<div id="results"></div></div>';

        gridEl = null;
        entries = [];
        drawn = 0;

        if (!term) {
            focusContent(0);
            return;
        }

        busy(true);
        Pluto.search(term).then(function (list) {
            if (my !== token) { return; }
            busy(false);

            var box = document.getElementById("results");
            if (!box) { return; }

            if (!list.length) {
                box.innerHTML = '<div class="notice"><b>No results</b>' +
                    "Try another word.</div>";
                focusContent(0);
                return;
            }

            /*
             * Drawn here rather than through listing(), which replaces the
             * whole view and would take the search action above the results
             * with it. Every card is drawn at once: a search returns a screen
             * or two, not the two hundred titles a letter of an index does.
             */
            entries = list;
            drawn = list.length;
            box.innerHTML = '<div class="grid">' +
                list.map(function (e, i) {
                    return cardHtml(e, i);
                }).join("") + "</div>";
            gridEl = box.querySelector(".grid");
            focusContent(frame_focus());
        }, function (err) {
            if (my !== token) { return; }
            busy(false);
            toast((err && err.message) || "Search failed", true);
            focusContent(0);
        });
    }

    /*
     * The series and season number behind a season entry.
     *
     * Pluto serves every season of a series in one response and gives a season
     * no id of its own, so the entry carries both halves and this takes them
     * apart again. The series id is split off at the last colon, since it is
     * the season number that cannot contain one.
     */
    function seasonRef(id) {
        var rest = id.substring(id.indexOf(":") + 1);
        var cut = rest.lastIndexOf(":");
        return {
            series: rest.substring(0, cut),
            number: rest.substring(cut + 1)
        };
    }

    function frame_focus() {
        var top = stack[stack.length - 1];
        return top ? top.focus : 0;
    }

    // Hand the field the keyboard, and take it back when the field is done.
    // Reading the value on blur rather than on a key means the system keyboard
    // can commit however it likes.
    function editSearch() {
        var box = document.getElementById("searchbox");
        if (!box) {
            return;
        }
        var top = stack[stack.length - 1];
        box.hidden = false;
        box.value = (top && top.param) || "";
        Input.suspend();

        var finish = function () {
            box.removeEventListener("blur", finish);
            Input.resume();
            var value = box.value.trim();
            box.hidden = true;

            if (!value || !top) {
                render(stack[stack.length - 1]);
                return;
            }

            top.param = value;
            top.focus = 0;
            render(top);
        };

        box.addEventListener("blur", finish);
        box.focus();
    }

    /*
     * A page of shelves -- the start page, a category, the live page. Each row
     * is fetched on its own so one slow panel does not hold up the others, and
     * a row that fails says so in place rather than taking the page with it.
     */
    function renderShelves(my, rows) {
        if (my !== token) {
            return;
        }

        if (!rows.length) {
            busy(false);
            notice("Empty", "There is nothing on this page right now.");
            focusFallback();
            return;
        }

        elContent.innerHTML = rows.map(function (r, i) {
            return '<h2 class="section-title">' + esc(r.name || "Rad " + (i + 1)) +
                (r.detail ? "<span>" + esc(r.detail) + "</span>" : "") + "</h2>" +
                '<div class="shelf" id="shelf-' + i + '"></div>';
        }).join("");

        var pending = rows.length;
        var want = stack[stack.length - 1].focus;
        var placed = false;

        function place() {
            if (placed || railLock) { return; }
            var cards = Input.all(SCOPE);
            if (!cards.length) { return; }
            placed = true;
            Input.focusIndex(Math.min(want, cards.length - 1), SCOPE);
        }

        rows.forEach(function (r, i) {
            Pluto.panel(r.panelId, r.kind).then(function (list) {
                if (my !== token) { return; }
                var shelf = document.getElementById("shelf-" + i);
                if (!shelf) { return; }

                // Shelves resolve in whatever order they finish, so index each
                // card against the running total rather than its row.
                var base = entries.length;
                entries = entries.concat(list);
                drawn = entries.length;
                shelf.innerHTML = list.map(function (e, n) {
                    return cardHtml(e, base + n);
                }).join("");

                // A cold start puts the cursor on the first card that appears;
                // a remembered position waits until every row is in.
                if (!want) { place(); }
            }, function (err) {
                if (my !== token) { return; }
                var shelf = document.getElementById("shelf-" + i);
                if (shelf) {
                    shelf.innerHTML = '<div class="notice">' +
                        esc((err && err.message) || "could not be loaded") +
                        "</div>";
                }
            }).then(function () {
                if (my !== token) { return; }
                pending--;
                if (pending === 0) {
                    busy(false);
                    place();
                    if (!placed) { focusFallback(); }
                }
            });
        });
    }

    /* ------------------------------------------------------------ opening */

    function openFocused() {
        var el = Input.current();
        if (!el) {
            return;
        }

        // The view behind a rail item is already on screen -- focusing the item
        // loaded it -- so Cross is simply "into the listing", same as Right.
        if (el.getAttribute("data-rail")) {
            enterContent();
            return;
        }

        var action = el.getAttribute("data-action");
        if (action === "search") {
            editSearch();
            return;
        }
        if (action === "refresh") {
            toast("Renewing the session…");
            Pluto.clearCache();
            render(stack[stack.length - 1]);
            return;
        }
        if (action === "reload") {
            reload();
            return;
        }

        var i = parseInt(el.getAttribute("data-i"), 10);
        if (isNaN(i) || !entries[i]) {
            return;
        }
        openEntry(entries[i]);
    }

    function openEntry(entry) {
        if (entry.type === "folder") {
            if (entry.id.indexOf("series:") === 0) {
                go(frameOf("series", entry.id.substring(7), entry.name));
            } else if (entry.id.indexOf("season:") === 0) {
                go(frameOf("season", seasonRef(entry.id), entry.name));
            } else if (entry.id.indexOf("cat:") === 0) {
                go(frameOf("category", entry.id.substring(4), entry.name));
            } else if (entry.id.indexOf("chcat:") === 0) {
                go(frameOf("channels", entry.id.substring(6), entry.name));
            }
            return;
        }
        play(entry);
    }

    /* ------------------------------------------------------------- player */

    var hls = null;
    var currentEntry = null;
    var osdTimer = null;
    var seekAccum = 0;
    var seekTimer = null;

    /*
     * The listing the current item was started from, kept so that the
     * remote's Track Next/Previous can step along it -- the next episode of a
     * season, the next channel in Kanaler -- without going back to the grid.
     * It is a copy: the browse listing is rebuilt whenever a view is drawn,
     * and what is playing should not depend on what is behind it.
     */
    var playlist = [];
    var playIndex = -1;

    /*
     * Which play() is the current one.
     *
     * Resolving a stream is several requests deep, and pressing Track Next
     * twice starts a second one while the first is still in flight. mode
     * alone cannot tell them apart -- both see "player" -- so each play()
     * takes a number and anything it started checks that its number is still
     * the one before touching the element.
     */
    var playToken = 0;

    function playing(my) {
        return my === playToken && mode === "player";
    }

    function nativeHls() {
        return !!(video.canPlayType &&
                  (video.canPlayType("application/vnd.apple.mpegurl") ||
                   video.canPlayType("application/x-mpegurl")));
    }

    function loadScript(src, name, ready) {
        if (ready()) {
            return Promise.resolve();
        }
        return new Promise(function (resolve, reject) {
            var s = document.createElement("script");
            s.src = src;
            s.onload = resolve;
            s.onerror = function () {
                reject(new Error(name + " kunde inte laddas"));
            };
            document.head.appendChild(s);
        });
    }

    function loadHlsJs() {
        return loadScript("https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js",
                          "hls.js",
                          function () { return !!window.Hls; });
    }

    function posKey(id) {
        return "tv4play.pos." + id;
    }

    function savePos() {
        if (!currentEntry || !isFinite(video.duration) || video.duration < 300) {
            return;
        }
        try {
            var t = video.currentTime;
            if (t > 60 && t < video.duration - 90) {
                localStorage.setItem(posKey(currentEntry.id), String(Math.floor(t)));
            } else {
                localStorage.removeItem(posKey(currentEntry.id));
            }
        } catch (e) { /* private mode, no storage: not worth a message */ }
    }

    function resumePos(id) {
        try {
            var v = parseInt(localStorage.getItem(posKey(id)), 10);
            return isNaN(v) ? 0 : v;
        } catch (e) {
            return 0;
        }
    }

    /* --------------------------------------------------------- stream info
     *
     * Nothing in the media element reports "what am I playing" directly, so
     * three sources are combined and whichever answers is used:
     *
     *   videoWidth/Height        always there, and it follows ABR switches
     *   webkit*DecodedByteCount  WebKit-only, differentiated into a real bitrate
     *   the master playlist      declared bandwidth, codecs and frame rate
     *
     * hls.js, when it is the one playing, knows all of it already. Every read
     * is guarded: an embedded build that exposes none of this still shows a
     * resolution, and the line simply gets shorter.
     */

    var variants = null;
    // Audio renditions declared with EXT-X-MEDIA. Null means the manifest was
    // never read (CORS, offline); an empty list means the audio is muxed into
    // the variant streams, which is the only shape WebKit HLS handles here.
    var audioTracks = null;
    var statsTimer = null;
    var statsPrev = null;
    var stats = {w: 0, h: 0, fps: 0, kbps: 0, dropped: 0, total: 0, buf: 0};

    function attr(line, name) {
        var m = new RegExp("[,:]" + name + "=(\"[^\"]*\"|[^,]*)").exec(line);
        if (!m) {
            return "";
        }
        return m[1].charAt(0) === '"' ? m[1].slice(1, -1) : m[1];
    }

    function parseMaster(text) {
        var lines = String(text).split(/\r?\n/);
        var out = [];
        var i, m, a, v;
        audioTracks = [];
        for (i = 0; i < lines.length; i++) {
            // An audio rendition with a URI of its own is audio that does not
            // travel inside the video segments, and is what has to be fetched
            // and mixed in separately.
            if (lines[i].indexOf("#EXT-X-MEDIA:") === 0 &&
                lines[i].indexOf("TYPE=AUDIO") > 0) {
                audioTracks.push({
                    group: attr(lines[i], "GROUP-ID"),
                    name: attr(lines[i], "NAME"),
                    language: attr(lines[i], "LANGUAGE"),
                    channels: attr(lines[i], "CHANNELS"),
                    isDefault: attr(lines[i], "DEFAULT") === "YES",
                    uri: attr(lines[i], "URI")
                });
            }
            if (lines[i].indexOf("#EXT-X-STREAM-INF:") !== 0) {
                continue;
            }
            a = lines[i].slice(18);
            v = {bandwidth: 0, width: 0, height: 0, codecs: "", fps: 0};
            m = /AVERAGE-BANDWIDTH=(\d+)/.exec(a);
            if (m) { v.bandwidth = parseInt(m[1], 10); }
            m = /[^-]BANDWIDTH=(\d+)/.exec(" " + a);
            if (m && !v.bandwidth) { v.bandwidth = parseInt(m[1], 10); }
            m = /RESOLUTION=(\d+)x(\d+)/.exec(a);
            if (m) { v.width = parseInt(m[1], 10); v.height = parseInt(m[2], 10); }
            m = /CODECS="([^"]*)"/.exec(a);
            if (m) { v.codecs = m[1]; }
            m = /FRAME-RATE=([\d.]+)/.exec(a);
            if (m) { v.fps = parseFloat(m[1]); }
            v.audioGroup = attr("," + a, "AUDIO");
            out.push(v);
        }
        return out.length ? out : null;
    }

    // The manifest is fetched a second time for its metadata, and to choose a
    // playback engine before anything is attached. It is in the CDN cache by
    // now, and a refusal is not worth reporting: the answer is then simply
    // "unknown", and attach() keeps the old behaviour. Never rejects.
    function loadMaster(url) {
        variants = null;
        audioTracks = null;
        if (!window.fetch) {
            return Promise.resolve();
        }
        return fetch(url, {credentials: "omit"}).then(function (r) {
            return r.ok ? r.text() : "";
        }).then(function (t) {
            if (t) {
                variants = parseMaster(t);
            }
        })["catch"](function () { /* measured values still work */ });
    }

    // True when the audio lives in playlists of its own rather than inside the
    // video segments. WebKit's built-in HLS on this console loads the video
    // renditions and silently ignores the alternate audio group, which is a
    // picture and no sound; hls.js fetches both and feeds them to MSE itself.
    //
    // Null when the manifest could not be read, so the caller can tell "muxed"
    // from "no idea".
    function hasSeparateAudio() {
        if (!audioTracks) {
            return null;
        }
        return audioTracks.some(function (t) { return !!t.uri; });
    }

    function codecName(s) {
        var seen = [];
        String(s).split(/[,\s]+/).forEach(function (c) {
            var n = c.indexOf("hvc1") === 0 || c.indexOf("hev1") === 0 ? "HEVC"
                : c.indexOf("avc1") === 0 || c.indexOf("avc3") === 0 ? "H.264"
                : c.indexOf("av01") === 0 ? "AV1"
                : c.indexOf("vp09") === 0 ? "VP9"
                : c.indexOf("mp4a.40.5") === 0 ? "HE-AAC"
                : c.indexOf("mp4a") === 0 ? "AAC"
                : c === "ec-3" ? "Dolby Digital+"
                : c === "ac-3" ? "Dolby Digital"
                : c ? c : "";
            if (n && seen.indexOf(n) < 0) { seen.push(n); }
        });
        return seen.join(" / ");
    }

    // Which rendition is on screen. hls.js says so; natively it has to be
    // inferred from the height, and where several renditions share a height
    // the measured bitrate breaks the tie.
    function variant() {
        var best = null;
        var i, v, d, bd;
        if (hls && hls.levels && hls.currentLevel >= 0) {
            v = hls.levels[hls.currentLevel];
            return {
                bandwidth: v.bitrate || 0,
                width: v.width || 0,
                height: v.height || 0,
                codecs: [v.videoCodec || "", v.audioCodec || ""].join(","),
                fps: v.frameRate || 0
            };
        }
        if (!variants || !video.videoHeight) {
            return null;
        }
        for (i = 0; i < variants.length; i++) {
            v = variants[i];
            if (v.height !== video.videoHeight) {
                continue;
            }
            if (!best) { best = v; continue; }
            d = Math.abs(v.bandwidth / 1000 - stats.kbps);
            bd = Math.abs(best.bandwidth / 1000 - stats.kbps);
            if (stats.kbps && d < bd) { best = v; }
        }
        return best;
    }

    function quality() {
        if (video.getVideoPlaybackQuality) {
            var q = video.getVideoPlaybackQuality();
            return {
                total: q.totalVideoFrames || 0,
                dropped: q.droppedVideoFrames || 0
            };
        }
        return {
            total: video.webkitDecodedFrameCount || 0,
            dropped: video.webkitDroppedFrameCount || 0
        };
    }

    function bufferAhead() {
        try {
            var b = video.buffered;
            for (var i = b.length - 1; i >= 0; i--) {
                if (b.start(i) <= video.currentTime && b.end(i) >= video.currentTime) {
                    return b.end(i) - video.currentTime;
                }
            }
        } catch (e) { /* not seekable yet */ }
        return 0;
    }

    function sampleStats() {
        var now = Date.now();
        var q = quality();
        var bytes = (video.webkitVideoDecodedByteCount || 0) +
            (video.webkitAudioDecodedByteCount || 0);
        var dt;

        stats.w = video.videoWidth || 0;
        stats.h = video.videoHeight || 0;
        stats.dropped = q.dropped;
        stats.total = q.total;
        stats.buf = bufferAhead();

        // A pause, a seek or a rendition change resets the counters; a negative
        // delta means the sample is meaningless rather than that nothing arrived.
        if (statsPrev && !video.paused) {
            dt = (now - statsPrev.at) / 1000;
            if (dt > 0.4) {
                if (bytes > statsPrev.bytes) {
                    stats.kbps = Math.round((bytes - statsPrev.bytes) * 8 / dt / 1000);
                }
                if (q.total > statsPrev.total) {
                    stats.fps = Math.round((q.total - statsPrev.total) / dt);
                }
            }
        }
        statsPrev = {at: now, bytes: bytes, total: q.total};

        drawTech();
    }

    function bitrateText() {
        var v = variant();
        if (stats.kbps > 50) {
            return (stats.kbps / 1000).toFixed(1) + " Mbit/s";
        }
        if (v && v.bandwidth) {
            return "~" + (v.bandwidth / 1e6).toFixed(1) + " Mbit/s";
        }
        return "";
    }

    function fpsText() {
        var v = variant();
        if (stats.fps > 5) {
            return stats.fps + " fps";
        }
        return v && v.fps ? Math.round(v.fps) + " fps" : "";
    }

    function drawTech() {
        var v = variant();
        var out = [];
        if (stats.h) {
            out.push(esc(stats.w + "×" + stats.h));
        }
        if (fpsText()) { out.push(esc(fpsText())); }
        if (bitrateText()) { out.push(esc(bitrateText())); }
        if (v && v.codecs) { out.push(esc(codecName(v.codecs))); }
        // Dropped frames are the one number worth colouring: on this hardware
        // they are the difference between "it plays" and "it plays smoothly".
        if (stats.dropped > 0) {
            out.push('<span class="warn">' + stats.dropped + " tappade bilder</span>");
        }
        elTech.innerHTML = out.join(" · ");
    }

    function startStats() {
        stopStats();
        statsPrev = null;
        stats = {w: 0, h: 0, fps: 0, kbps: 0, dropped: 0, total: 0, buf: 0};
        elTech.innerHTML = "";
        statsTimer = setInterval(sampleStats, 1000);
    }

    function stopStats() {
        if (statsTimer) {
            clearInterval(statsTimer);
            statsTimer = null;
        }
        variants = null;
        audioTracks = null;
        elTech.innerHTML = "";
    }

    // An ABR switch shows up here before the next sample tick.
    video.addEventListener("resize", drawTech);

    /* -------------------------------------------------------------- start */

    /*
     * Start playback. list/index say what the item was picked out of; callers
     * that know it pass it, which playSibling() must, since by then stop()
     * has already cleared the one this reads from the listing.
     */
    function play(entry, list, index) {
        var my = ++playToken;

        if (list) {
            playlist = list;
            playIndex = index;
        } else {
            playIndex = entries.indexOf(entry);
            playlist = playIndex < 0 ? [entry] : entries.slice();
            playIndex = Math.max(0, playIndex);
        }

        currentEntry = entry;
        mode = "player";
        elPlayer.hidden = false;
        elSpinner.hidden = false;
        state("Loading…");
        showOsd(true);
        startStats();

        Pluto.resolve(entry.id).then(function (stream) {
            if (!playing(my)) {
                return;
            }

            // The engine is picked from what the manifest turns out to hold,
            // so reading it has to finish first.
            return loadMaster(stream.url).then(function () {
                if (!playing(my)) {
                    return;
                }
                return attach(stream.url, entry, my);
            });
        }, function (err) {
            if (!playing(my)) {
                return;
            }
            stop();
            toast((err && err.message) || "Could not start playback", true);
        });
    }

    function attach(url, entry, my) {
        var resume = entry.live ? 0 : resumePos(entry.id);

        function started() {
            // A metadata event from the source this one replaced would seek
            // and play the wrong programme.
            if (!playing(my)) {
                return;
            }
            elSpinner.hidden = true;
            if (resume > 5) {
                try { video.currentTime = resume; } catch (e) { /* live */ }
                toast("Resuming from " + fmtTime(resume));
            }
            var p = video.play();
            if (p && p["catch"]) {
                p["catch"](function (err) {
                    toast("Uppspelning blockerad: " + err.message, true);
                });
            }
        }

        function attachNative() {
            // { once: true } is silently ignored by some older WebKit builds,
            // which would re-seek on every metadata event.
            var onMeta = function () {
                video.removeEventListener("loadedmetadata", onMeta);
                started();
            };
            video.src = url;
            video.addEventListener("loadedmetadata", onMeta);
            video.load();
        }

        function attachHlsJs() {
            return loadHlsJs().then(function () {
                if (!window.Hls || !window.Hls.isSupported()) {
                    throw new Error("No HLS playback in this browser");
                }
                destroyHls();
                hls = new window.Hls({
                    enableWorker: true,
                    // A console has far less headroom than a desktop; holding
                    // half an hour of played-out segments is what turns a long
                    // programme into a stall.
                    backBufferLength: 30
                });
                hls.on(window.Hls.Events.MANIFEST_PARSED, started);
                hls.on(window.Hls.Events.ERROR, function (evt, data) {
                    if (data.fatal) {
                        toast("Stream error: " + data.details, true);
                        stop();
                    }
                });
                hls.loadSource(url);
                hls.attachMedia(video);
            });
        }

        // WebKit's own HLS is the cheaper path and the one the console decodes
        // in hardware, so it stays the default. It is only stepped around for
        // the manifests it gets wrong: those whose audio sits in renditions of
        // its own, which it loads no sound for at all.
        var separate = hasSeparateAudio();
        if (nativeHls() && separate !== true) {
            attachNative();
            return;
        }

        return attachHlsJs()["catch"](function (err) {
            if (!playing(my)) {
                return;
            }
            // Better a stream with no sound than no stream: if hls.js cannot
            // be had, hand the manifest back to WebKit.
            if (nativeHls()) {
                if (window.console) {
                    console.log("hls.js unavailable, falling back to WebKit: " +
                                err.message);
                }
                destroyHls();
                attachNative();
                return;
            }
            toast(err.message, true);
            stop();
        });
    }

    function destroyHls() {
        if (hls) {
            try { hls.destroy(); } catch (e) { /* already gone */ }
            hls = null;
        }
    }

    function stop() {
        savePos();
        // Anything still resolving belongs to a programme that is no longer
        // wanted, and must not attach itself once it arrives.
        playToken++;
        playlist = [];
        playIndex = -1;
        stopStats();
        try { video.pause(); } catch (e) { /* not started */ }
        destroyHls();
        video.removeAttribute("src");
        try { video.load(); } catch (e) { /* ignore */ }
        elPlayer.hidden = true;
        elSpinner.hidden = true;
        elOsd.className = "";
        currentEntry = null;
        mode = "browse";
    }

    // The title is refreshed on every showing rather than written once in
    // play(): whichever path put us in the player, the name on screen is the
    // name of the thing playing.
    function showOsd(sticky) {
        elName.textContent = currentEntry ? currentEntry.name : "";
        showDesc(currentEntry ? currentEntry.description : "");
        elOsd.className = "on";
        if (osdTimer) {
            clearTimeout(osdTimer);
            osdTimer = null;
        }
        if (!sticky) {
            osdTimer = setTimeout(function () {
                if (!video.paused) {
                    elOsd.className = "";
                }
            }, 4000);
        }
    }

    // The synopsis goes in the middle of the frame rather than into the bottom
    // bar: it is a paragraph, not a label, and there is no room beside the
    // times. Entries without one leave nothing behind, since an empty panel
    // over the picture reads as a fault.
    function showDesc(text) {
        var s = String(text == null ? "" : text).replace(/\s+/g, " ");
        s = s.replace(/^ /, "").replace(/ $/, "");
        elDesc.textContent = s;
        elDesc.hidden = !s;
    }

    function updateOsd() {
        var live = !isFinite(video.duration);
        var pct = live ? 100
            : (video.duration ? (video.currentTime / video.duration) * 100 : 0);
        elFill.style.width = pct + "%";
        elHead.style.left = pct + "%";
        elPos.textContent = live ? "LIVE" : fmtTime(video.currentTime);
        elDur.textContent = live ? "" : fmtTime(video.duration);
    }

    function state(msg) {
        elState.textContent = msg || "";
    }

    // Seek nudges arrive faster than the stream can respond, so add them up and
    // apply once the viewer stops pressing.
    function seek(delta) {
        if (!isFinite(video.duration)) {
            toast("Cannot seek in a live stream");
            return;
        }
        seekAccum += delta;
        var target = Math.max(0,
                              Math.min(video.duration - 1, video.currentTime + seekAccum));
        state((seekAccum > 0 ? "▶▶ +" : "◀◀ ") + fmtTime(Math.abs(seekAccum)) +
              "  →  " + fmtTime(target));
        showOsd(true);

        if (seekTimer) {
            clearTimeout(seekTimer);
        }
        seekTimer = setTimeout(function () {
            video.currentTime = target;
            seekAccum = 0;
            state("");
            showOsd(false);
        }, 350);
    }

    function togglePlay() {
        if (video.paused) {
            video.play();
        } else {
            video.pause();
        }
        showOsd(true);
    }

    // The remote has an information key of its own, and the OSD is what there
    // is to show: on demand rather than on a timer, so it can be read for as
    // long as it takes and then dismissed.
    function toggleOsd() {
        if (elOsd.className === "on") {
            if (osdTimer) {
                clearTimeout(osdTimer);
                osdTimer = null;
            }
            elOsd.className = "";
            return;
        }
        showOsd(true);
    }

    /*
     * Step to the next or previous item of the listing this one came from.
     *
     * Folders are skipped rather than opened: a season inside a series listing
     * is not something the player can do anything with, and stopping on it
     * would end playback where the viewer asked to continue it.
     */
    function playSibling(delta) {
        var list = playlist;
        var i = playIndex + delta;

        if (playIndex < 0 || list.length < 2) {
            toast("Nothing more in this list");
            return;
        }

        while (i >= 0 && i < list.length && list[i].type === "folder") {
            i += delta;
        }
        if (i < 0 || i >= list.length) {
            toast(delta > 0 ? "Last in the list" : "First in the list");
            return;
        }

        // stop() saves the position of what is playing and tears the engine
        // down; play() puts the player straight back up in the same turn, so
        // none of the teardown is ever painted.
        stop();
        play(list[i], list, i);
    }

    // A stall with the manifest still good is the one playback fault a viewer
    // can do something about from the sofa, so Red restarts the stream where
    // in the listing it restarts the view. stop() writes the position out
    // first, and play() resumes from it.
    function reloadStream() {
        var entry = currentEntry;
        var list = playlist;
        var i = playIndex;

        if (!entry) {
            return;
        }
        stop();
        toast("Startar om…");
        play(entry, list, i);
    }

    /*
     * Subtitles. Pluto declares them inside the HLS manifest rather than as
     * files alongside it, so both WebKit and hls.js surface them as text
     * tracks on their own and there is nothing to load here.
     */
    function subtitleTracks() {
        var out = [];
        var t = video.textTracks;
        var i;
        for (i = 0; t && i < t.length; i++) {
            if (t[i].kind === "subtitles" || t[i].kind === "captions" ||
                !t[i].kind) {
                out.push(t[i]);
            }
        }
        return out;
    }

    function cycleTextTracks() {
        var tracks = subtitleTracks();
        if (!tracks.length) {
            toast("No subtitle tracks in this stream");
            return;
        }
        var active = -1;
        var i;
        for (i = 0; i < tracks.length; i++) {
            if (tracks[i].mode === "showing") {
                active = i;
            }
            tracks[i].mode = "disabled";
        }
        var next = active + 1;
        if (next >= tracks.length) {
            toast("Subtitles off");
            if (hls) { hls.subtitleTrack = -1; }
            return;
        }
        tracks[next].mode = "showing";
        // A rendition hls.js owns has to be selected on the hls side too or no
        // cues are ever parsed into it. Match by label rather than by index.
        if (hls && hls.subtitleTracks && hls.subtitleTracks.length) {
            var h = -1;
            for (i = 0; i < hls.subtitleTracks.length; i++) {
                if ((hls.subtitleTracks[i].name || "") === tracks[next].label) {
                    h = i;
                }
            }
            hls.subtitleTrack = h;
        }
        toast("Subtitles: " + (tracks[next].label || tracks[next].language || next));
    }

    function cycleAudioTracks() {
        if (hls && hls.audioTracks && hls.audioTracks.length > 1) {
            var n = (hls.audioTrack + 1) % hls.audioTracks.length;
            hls.audioTrack = n;
            toast("Audio: " + (hls.audioTracks[n].name || n));
            return;
        }
        var at = video.audioTracks;
        if (at && at.length > 1) {
            var cur = 0;
            for (var i = 0; i < at.length; i++) {
                if (at[i].enabled) { cur = i; }
            }
            var next = (cur + 1) % at.length;
            for (i = 0; i < at.length; i++) {
                at[i].enabled = (i === next);
            }
            toast("Audio: " + (at[next].label || at[next].language || next));
            return;
        }
        toast("Only one audio track");
    }

    video.addEventListener("timeupdate", updateOsd);
    video.addEventListener("durationchange", updateOsd);
    video.addEventListener("progress", updateOsd);
    video.addEventListener("waiting", function () {
        elSpinner.hidden = false;
    });
    video.addEventListener("playing", function () {
        elSpinner.hidden = true;
        state("");
        showOsd(false);
    });
    video.addEventListener("pause", function () {
        state("Pausad");
        showOsd(true);
        savePos();
    });
    video.addEventListener("ended", function () {
        if (currentEntry) {
            try { localStorage.removeItem(posKey(currentEntry.id)); } catch (e) {}
        }
        stop();
    });
    video.addEventListener("error", function () {
        var e = video.error;
        // Clearing src on the way out is an error as far as the element is
        // concerned, and the event for it can arrive after the next
        // programme has already been asked for -- which is what Track Next
        // does. Nothing is attached at that point, so there is nothing to
        // report and certainly nothing to stop.
        if (!video.currentSrc) {
            return;
        }
        // Every failure lands here: there is one playback path and it is the
        // media element's, whether hls.js is feeding it or WebKit is reading
        // the manifest itself.
        toast("Playback error" + (e ? " (kod " + e.code + ")" : ""), true);
        stop();
    });

    /* -------------------------------------------------------------- input */

    Input.setHandler(function (code) {
        if (mode === "player") {
            playerKey(code);
            return;
        }

        browseKey(code);
    });

    /*
     * Up from the top row, Down from the bottom one.
     *
     * There is no card that way, but there may well be pixels: a series header
     * sits above the first row and belongs to no cursor position, so without
     * this the only way to see it would be a mouse the console does not have.
     * The ends are what is wanted here rather than a page at a time -- the
     * header is the whole of what is above the grid.
     */
    function scrollEdge(dir) {
        if (!elContent) {
            return;
        }
        elContent.scrollTop = dir < 0 ? 0 : elContent.scrollHeight;
    }

    function reload() {
        Pluto.clearCache();
        toast("Refreshing…");
        render(stack[stack.length - 1]);
    }

    /*
     * Straight to a top-level view, throwing the stack away -- what the
     * remote's Guide key does, where the rail's own items only ever open the
     * view they are already sitting under. Playback is left behind first: the
     * viewer asked for a listing, not a listing with a programme still
     * running behind it.
     */
    function jumpTo(id) {
        if (mode === "player") {
            stop();
        }

        /*
         * Take the cursor out of the rail before drawing.
         *
         * render() puts the ring back on the item that had it, and having the
         * ring is what opens the view behind it -- so leaving the cursor
         * where it was would schedule a load of the old view and undo the
         * jump a fifth of a second later. With nothing focused there is
         * nothing to restore, railLock stays clear, and the listing takes the
         * cursor as it arrives, which is where a viewer who named a view
         * wants it.
         */
        cancelRail();
        Input.blur();

        stack = [frameOf(id, null, null)];
        render(stack[0]);
    }

    /*
     * Channel Up/Down move a screenful at a time.
     *
     * Distance is measured against the listing's own scroll position rather
     * than the viewport: revealing each card scrolls the container under it,
     * so a card a page further down sits at much the same place on screen and
     * a viewport measurement would never reach the end of its page.
     */
    function pageMove(dir) {
        var cur, page, from, moved, guard, el;

        if (inRail()) {
            Input.move(dir, elRail);
            return;
        }

        cur = Input.current(SCOPE);
        if (!cur) {
            Input.focusIndex(0, SCOPE);
            return;
        }

        function offset(node) {
            return node.getBoundingClientRect().top + SCOPE.scrollTop;
        }

        // A screenful less the row being left behind, so that row is still on
        // screen afterwards: a page that lands on wholly unseen cards gives
        // the eye nothing to carry across. Taking the height from the card
        // under the cursor sizes it for whatever is being shown, a shelf of
        // posters or a grid of chips.
        from = offset(cur);
        page = Math.max(1, SCOPE.clientHeight -
                        cur.getBoundingClientRect().height);
        moved = null;
        guard = 60;

        while (guard--) {
            el = Input.move(dir, SCOPE);
            if (!el) {
                break;
            }
            moved = el;
            if (Math.abs(offset(el) - from) >= page) {
                break;
            }
        }

        // Already on the last row: no card to move to, but there may well be
        // pixels below it.
        if (!moved) {
            scrollEdge(dir === "down" ? 1 : -1);
        }
    }

    function browseKey(code) {
        switch (code) {
        case K.LEFT:
            // Left off the edge of the listing goes to the menu -- to the item
            // this view belongs to, not to whichever one happens to be level
            // with the card. Remember where we were so Right comes back.
            if (!inRail() && !Input.move("left", SCOPE, true)) {
                var top = stack[stack.length - 1];
                if (top) {
                    top.focus = Math.max(0, Input.indexOfFocused(SCOPE));
                }
                focusRail();
            }
            break;
        case K.RIGHT:
            if (inRail()) {
                enterContent();
            } else {
                Input.move("right", SCOPE);
            }
            break;
        case K.UP:
            if (inRail()) {
                Input.move("up", elRail);
            } else if (!Input.move("up", SCOPE)) {
                scrollEdge(-1);
            }
            break;
        case K.DOWN:
            if (inRail()) {
                Input.move("down", elRail);
            } else if (!Input.move("down", SCOPE)) {
                scrollEdge(1);
            }
            break;
        case K.CROSS: openFocused(); break;
        case K.CIRCLE: back(); break;
        case K.TRIANGLE: reload(); break;

        /*
         * The television's remote.
         *
         * Green opens and Red reloads, which is what Cross and Triangle do on
         * the pad, so a viewer who has put the pad down loses nothing. The
         * rest do what their labels say: the rail is this app's top menu, the
         * channel list is its guide, and Channel Up/Down is the one pair with
         * no pad equivalent -- a screenful at a time, which is what the
         * letter listings want and what the D-pad is slowest at.
         */
        case K.TOP_MENU:
            focusRail();
            break;
        case K.GUIDE:
            jumpTo("live");
            break;
        case K.CHAN_UP:
            pageMove("up");
            break;
        case K.CHAN_DOWN:
            pageMove("down");
            break;
        case K.GREEN: openFocused(); break;
        case K.RED: reload(); break;
        default: break;
        }
    }

    function playerKey(code) {
        switch (code) {
        case K.CROSS:
            togglePlay();
            break;
        case K.CIRCLE:
            stop();
            break;
            // Left/Right nudge, Up/Down take the long stride. Both go through the
            // same accumulator, so holding Down and then tapping Right adds up to
            // one seek rather than a stutter of separate ones.
        case K.LEFT:  seek(-10); break;
        case K.RIGHT: seek(10); break;
        case K.DOWN:  seek(-300); break;
        case K.UP:    seek(300); break;
        case K.SQUARE:   cycleTextTracks(); showOsd(false); break;
        case K.TRIANGLE: cycleAudioTracks(); showOsd(false); break;

        /*
         * The television's remote. A transport key does the thing it is
         * printed with, so nothing here needs to be learnt.
         *
         * Rewind and Fast forward take half a minute at a time -- between the
         * D-pad's ten seconds and its five minutes, and the stride a viewer
         * reaches for when the titles are running. They share the seek
         * accumulator with the D-pad, so a burst of presses is still one
         * seek.
         *
         * Channel Up/Down are aliases of Track Next/Previous rather than a
         * mapping of their own: with a live channel playing they are exactly
         * that, and with a season playing they are the key a hand finds
         * without looking down.
         */
        case K.PAUSE:
        case K.GREEN:
            togglePlay();
            break;
        case K.STOP:
            stop();
            break;
        case K.TOP_MENU:
            stop();
            focusRail();
            break;
        case K.GUIDE:
            jumpTo("live");
            break;
        case K.REWIND:  seek(-30); break;
        case K.FORWARD: seek(30); break;
        case K.NEXT:
        case K.CHAN_UP:
            playSibling(1);
            break;
        case K.PREV:
        case K.CHAN_DOWN:
            playSibling(-1);
            break;
        case K.SUBTITLE:
        case K.YELLOW:
            cycleTextTracks();
            showOsd(false);
            break;
        case K.BLUE:
            cycleAudioTracks();
            showOsd(false);
            break;
        case K.RED:
            reloadStream();
            break;
        case K.CONTEXT:
            toggleOsd();
            break;
        default: break;
        }
    }

    /* --------------------------------------------------------------- boot */

    tickClock();
    setInterval(tickClock, 20000);
    stack = [frameOf("start", null, null)];
    render(stack[0]);

    // The rail exists as soon as render() has drawn it. Put the cursor on the
    // first item: that sets railLock, so Start fills the right-hand side as its
    // shelves arrive but leaves the cursor in the menu.
    Input.focus(elRail.querySelector(".rail-item"));
}());
