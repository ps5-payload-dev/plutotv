var Input = (function () {
    "use strict";

    var KEY = {
	CROSS:    13,  // Enter
	CIRCLE:   27,  // Escape
	LEFT:     37,
	UP:       38,
	RIGHT:    39,
	DOWN:     40,
	TRIANGLE: 112, // F1
	SQUARE:   113, // F2

	/*
	 * The browser turns HDMI-CEC presses on the television's own remote
	 * into key events of their own, in a range of their own that no pad
	 * button occupies. They arrive through the same keydown, so they are
	 * named here alongside the pad and handled in the same place.
	 */
	TOP_MENU:  131, // MediaTopMenu
	REWIND:    133, // MediaRewind
	FORWARD:   134, // MediaFastForward
	PAUSE:     135, // MediaPause
	CONTEXT:   136, // TVMediaContext
	SUBTITLE:  139, // Subtitle
	BLUE:      152, // ColorF3Blue
	RED:       153, // ColorF0Red
	GREEN:     154, // ColorF1Green
	YELLOW:    155, // ColorF2Yellow
	CHAN_UP:   157, // ChannelUp
	CHAN_DOWN: 158, // ChannelDown
	NEXT:      176, // MediaTrackNext
	PREV:      177, // MediaTrackPrevious
	STOP:      178, // MediaStop
	GUIDE:     216  // Guide
    };

    // Held directions should repeat, but the browser's own key repeat on a
    // gamepad-driven key event is not something to rely on, so throttle it here
    // and let repeats through at a steady rate.
    var REPEAT_MS = 90;
    var lastRepeat = 0;

    /*
     * Which keys a held press may repeat.
     *
     * Only the ones whose action is a small step: another card along, another
     * ten seconds of seek. A remote held down on Channel Up would otherwise
     * tear through a season an episode at a time, each one a stream teardown
     * and a fresh request, and a leant-on Cross would open the same card
     * again and again. For everything else the first press is the press.
     */
    var REPEATABLE = [
	KEY.LEFT, KEY.UP, KEY.RIGHT, KEY.DOWN, KEY.REWIND, KEY.FORWARD
    ];

    // Every code in the mapping above. Anything else is left to the browser,
    // so a text field added later still works.
    var HANDLED = (function () {
	var out = [];
	var name;
	for (name in KEY) {
	    if (KEY.hasOwnProperty(name)) {
		out.push(KEY[name]);
	    }
	}
	return out;
    }());

    var handler = null;

    function setHandler(fn) {
	handler = fn;
    }

    /*
     * Text entry.
     *
     * Everything in HANDLED is taken away from the browser, which is right for
     * a listing and fatal for a text field: the on-screen keyboard needs the
     * arrows and Enter for itself. Suspending hands them all back until the
     * field is done with them.
     *
     * On the console the keyboard is modal -- the page sees none of it while it
     * is open -- so the field's own blur event is the reliable signal to
     * resume, rather than any keypress.
     */
    var suspended = false;

    function suspend() {
	suspended = true;
    }

    function resume() {
	suspended = false;
    }

    function repeats(code) {
	return REPEATABLE.indexOf(code) >= 0;
    }

    document.addEventListener("keydown", function (e) {
	var code = e.keyCode || e.which;

	// Not every embedded build reports keyCode for Enter/Escape/arrows,
	// and a remote key is the more likely of the two to arrive as a name
	// only, since the codes for those are not the ones any desktop
	// keyboard produces.
	if (!code && e.key) {
	    code = ({
		Enter: 13, Escape: 27, Esc: 27,
		ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
		F1: 112, F2: 113,
		MediaTopMenu: 131, MediaRewind: 133, MediaFastForward: 134,
		MediaPause: 135, TVMediaContext: 136, Subtitle: 139,
		ColorF3Blue: 152, ColorF0Red: 153, ColorF1Green: 154,
		ColorF2Yellow: 155, ChannelUp: 157, ChannelDown: 158,
		MediaTrackNext: 176, MediaTrackPrevious: 177, MediaStop: 178,
		Guide: 216
	    })[e.key] || 0;
	}

	// A field has the keyboard: let every key through untouched.
	if (suspended) {
	    return;
	}

	if (!code || !handler || HANDLED.indexOf(code) < 0) {
	    return;
	}

	// F1-F3 and the arrows would otherwise reach the browser chrome, and
	// the remote's transport keys its own media handling.
	e.preventDefault();
	e.stopPropagation();

	if (e.repeat) {
	    if (!repeats(code)) {
		return;
	    }
	    var now = Date.now();
	    if (now - lastRepeat < REPEAT_MS) {
		return;
	    }
	    lastRepeat = now;
	}

	handler(code, e);
    }, true);

    /* -------------------------------------------------------------- focus */

    function all(scope) {
	var root = scope || document;
	return Array.prototype.slice.call(
	    root.querySelectorAll(".focusable")
	).filter(function (el) {
	    return el.offsetParent !== null || el.offsetWidth > 0;
	});
    }

    function current(scope) {
	var root = scope || document;
	return root.querySelector(".focusable.focused");
    }

    function centre(el) {
	var r = el.getBoundingClientRect();
	return {
	    x: r.left + r.width / 2,
	    y: r.top + r.height / 2,
	    r: r
	};
    }

    // Is el on the same row as the very first focusable inside p? The first
    // one in document order is by definition in the top row, so two rects
    // answer it -- cheap enough to ask on every focus change, which walking
    // the whole listing would not be.
    function inFirstRow(el, p) {
	var head = p.querySelector(".focusable");
	if (!head || head === el) {
	    return true;
	}
	return el.getBoundingClientRect().top <
	    head.getBoundingClientRect().bottom - 1;
    }

    // Nudge the element into view inside every scrollable ancestor, keeping a
    // margin so the next card along is always partly visible -- on a TV a card
    // flush against the edge reads as the end of the list.
    function reveal(el) {
	var p = el.parentElement;
	while (p && p !== document.body && p !== document.documentElement) {
	    var style = window.getComputedStyle(p);
	    var scrollsY = /(auto|scroll)/.test(style.overflowY);
	    var scrollsX = /(auto|scroll)/.test(style.overflowX);
	    if (scrollsY || scrollsX) {
		var er = el.getBoundingClientRect();
		var pr = p.getBoundingClientRect();
		var padX = Math.min(120, pr.width * 0.12);
		var padY = Math.min(90, pr.height * 0.16);

		if (scrollsX) {
		    if (er.left < pr.left + padX) {
			p.scrollLeft += er.left - pr.left - padX;
		    } else if (er.right > pr.right - padX) {
			p.scrollLeft += er.right - pr.right + padX;
		    }
		}

		if (scrollsY) {
		    /*
		     * Anything above the first row -- a series header, a
		     * section title -- holds no focus of its own, so the
		     * minimum scroll that shows the top row is the one thing
		     * that hides it for good: there is no cursor target up
		     * there to scroll back to. Whenever the top row is
		     * reachable with the container wound fully back, wind it
		     * fully back.
		     */
		    var offset = er.top - pr.top + p.scrollTop;
		    if (inFirstRow(el, p) &&
			offset + er.height <= p.clientHeight) {
			p.scrollTop = 0;
		    } else if (er.top < pr.top + padY) {
			p.scrollTop += er.top - pr.top - padY;
		    } else if (er.bottom > pr.bottom - padY) {
			p.scrollTop += er.bottom - pr.bottom + padY;
		    }
		}
	    }
	    p = p.parentElement;
	}
    }

    var onFocusChange = null;

    function setFocusListener(fn) {
	onFocusChange = fn;
    }

    function focus(el) {
	if (!el) {
	    return null;
	}
	// Only ever one focused element in the app, whatever scope the caller
	// was indexing within -- otherwise the rail keeps its ring when the
	// cursor jumps into a freshly drawn listing.
	var was = document.querySelector(".focusable.focused");
	if (was && was !== el) {
	    was.className = was.className.replace(/\s*\bfocused\b/, "");
	}
	if (el.className.indexOf("focused") < 0) {
	    el.className += " focused";
	}
	reveal(el);
	if (onFocusChange) {
	    onFocusChange(el);
	}
	return el;
    }

    // Take the cursor off whatever holds it, leaving nothing focused. Only
    // wanted where a view is about to be replaced and the old ring must not
    // be carried into the new one.
    function blur() {
	var el = document.querySelector(".focusable.focused");
	if (el) {
	    el.className = el.className.replace(/\s*\bfocused\b/, "");
	}
    }

    function focusFirst(scope) {
	return focus(all(scope)[0]);
    }

    function focusIndex(i, scope) {
	var items = all(scope);
	return focus(items[Math.max(0, Math.min(items.length - 1, i))]);
    }

    function indexOfFocused(scope) {
	return all(scope).indexOf(current(scope));
    }

    /*
     * Score = distance along the direction of travel + a heavy penalty for
     * drifting sideways, so pressing Down from the third card of a shelf lands
     * on the third card of the next one rather than on whatever happens to be
     * closest as the crow flies.
     */
    function move(dir, scope, nowrap) {
	var items = all(scope);
	var cur = current(scope);
	if (!items.length) {
	    return null;
	}
	if (!cur) {
	    return focus(items[0]);
	}

	var c = centre(cur);
	var best = null;
	var bestScore = Infinity;
	var SLACK = 6;

	items.forEach(function (el) {
	    if (el === cur) {
		return;
	    }
	    var t = centre(el);
	    var dx = t.x - c.x;
	    var dy = t.y - c.y;
	    var along, across;

	    if (dir === "left") {
		if (dx > -SLACK) { return; }
		along = -dx; across = Math.abs(dy);
	    } else if (dir === "right") {
		if (dx < SLACK) { return; }
		along = dx; across = Math.abs(dy);
	    } else if (dir === "up") {
		if (dy > -SLACK) { return; }
		along = -dy; across = Math.abs(dx);
	    } else {
		if (dy < SLACK) { return; }
		along = dy; across = Math.abs(dx);
	    }

	    // Overlapping on the cross axis means "same row" / "same column".
	    var overlap = (dir === "left" || dir === "right")
		? (t.r.bottom > c.r.top && t.r.top < c.r.bottom)
		: (t.r.right > c.r.left && t.r.left < c.r.right);

	    var score = along + across * (overlap ? 0.2 : 3);
	    if (score < bestScore) {
		bestScore = score;
		best = el;
	    }
	});

	// Nothing that way. In a wrapping grid, running off the end of a row
	// should continue on the next one rather than dead-end, so fall back to
	// document order for left/right. Callers that need to know they have
	// hit a real edge -- Left out of the listing and into the nav rail --
	// pass nowrap and get null instead.
	if (!best && !nowrap && (dir === "left" || dir === "right")) {
	    var i = items.indexOf(cur) + (dir === "right" ? 1 : -1);
	    best = items[i] || null;
	}

	return best ? focus(best) : null;
    }

    return {
	KEY: KEY,
	setHandler: setHandler,
	setFocusListener: setFocusListener,
	suspend: suspend,
	resume: resume,
	all: all,
	current: current,
	focus: focus,
	blur: blur,
	reveal: reveal,
	focusFirst: focusFirst,
	focusIndex: focusIndex,
	indexOfFocused: indexOfFocused,
	move: move
    };
}());
