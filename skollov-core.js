/* MMM-Skollov — shared, side-effect-free logic.
 *
 * Loaded in two places:
 *   - node_helper.js (Node) uses parseICS/toHolidays to turn the feed into JSON.
 *   - MMM-Skollov.js (browser, via getScripts) uses computeView and the
 *     phrasing helpers to decide what to render.
 * Tests require it directly.
 *
 * All dates are handled as plain calendar dates ("YYYY-MM-DD" strings).
 * Arithmetic is done in UTC on those dates, so daylight-saving changes can
 * never shift a holiday by a day.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory();
	} else {
		root.SkollovCore = factory();
	}
})(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	const DAY_MS = 24 * 60 * 60 * 1000;

	/* ---------------------------------------------------------------- dates */

	function pad(n) {
		return String(n).padStart(2, "0");
	}

	function toUTC(dateStr) {
		const [y, m, d] = dateStr.split("-").map(Number);
		return Date.UTC(y, m - 1, d);
	}

	function fromUTC(ms) {
		const d = new Date(ms);
		return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
	}

	function addDays(dateStr, n) {
		return fromUTC(toUTC(dateStr) + n * DAY_MS);
	}

	/** Whole days from a to b (b - a). */
	function diffDays(a, b) {
		return Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
	}

	/** 0 = Sunday … 6 = Saturday */
	function weekday(dateStr) {
		return new Date(toUTC(dateStr)).getUTCDay();
	}

	/** The local calendar date of a JS Date (the mirror's own timezone). */
	function localDateString(date) {
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	}

	/* ----------------------------------------------------------- iCal parse */

	function unescapeText(value) {
		return value.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
	}

	/**
	 * Parse an iCal date or date-time value into { date: "YYYY-MM-DD", allDay, time }.
	 * Time zones on DATE-TIME values are ignored; only the calendar date is used.
	 */
	function parseDateValue(value, params) {
		const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value.trim());
		if (!m) return null;
		const allDay = params.VALUE === "DATE" || m[4] === undefined;
		return {
			date: `${m[1]}-${m[2]}-${m[3]}`,
			allDay,
			time: allDay ? null : `${m[4]}${m[5]}${m[6]}`
		};
	}

	/**
	 * Minimal RFC 5545 reader: handles CRLF/LF, folded lines, property
	 * parameters and text escaping. Only VEVENTs and a few calendar-level
	 * properties are kept; everything else is ignored.
	 */
	function parseICS(text) {
		if (typeof text !== "string" || !/BEGIN:VCALENDAR/.test(text)) {
			throw new Error("Not an iCalendar document");
		}
		// Unfold: a line starting with space or tab continues the previous one.
		const lines = text.replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");

		const calendar = { name: null, events: [] };
		let current = null;

		for (const raw of lines) {
			if (!raw) continue;
			const colon = raw.indexOf(":");
			if (colon < 0) continue;
			const head = raw.slice(0, colon);
			const value = raw.slice(colon + 1);
			const [name, ...paramParts] = head.split(";");
			const prop = name.toUpperCase();
			const params = {};
			for (const p of paramParts) {
				const eq = p.indexOf("=");
				if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
			}

			if (prop === "BEGIN" && value.toUpperCase() === "VEVENT") {
				current = {};
				continue;
			}
			if (prop === "END" && value.toUpperCase() === "VEVENT") {
				if (current) calendar.events.push(current);
				current = null;
				continue;
			}

			if (current) {
				if (prop === "DTSTART" || prop === "DTEND") {
					current[prop.toLowerCase()] = parseDateValue(value, params);
				} else if (["UID", "SUMMARY", "DESCRIPTION", "URL", "STATUS"].includes(prop)) {
					current[prop.toLowerCase()] = unescapeText(value);
				}
			} else if (prop === "X-WR-CALNAME") {
				calendar.name = unescapeText(value);
			}
		}
		return calendar;
	}

	/* ------------------------------------------------------------- holidays */

	const TYPES = {
		autumn: { name: "Höstlov", emoji: "🍂" },
		christmas: { name: "Jullov", emoji: "🎄" },
		sport: { name: "Sportlov", emoji: "⛷️" },
		easter: { name: "Påsklov", emoji: "🐣" },
		summer: { name: "Sommarlov", emoji: "☀️" }
	};
	const FALLBACK_EMOJI = "🎉";

	function classify(event) {
		const uidKey = /-(autumn|christmas|sport|easter|summer)-\d{8}@/.exec(event.uid || "");
		if (uidKey) return uidKey[1];
		const s = (event.summary || "").toLowerCase();
		if (/höstlov/.test(s)) return "autumn";
		if (/jullov/.test(s)) return "christmas";
		if (/sportlov|vinterlov/.test(s)) return "sport";
		if (/påsklov/.test(s)) return "easter";
		if (/sommarlov/.test(s)) return "summer";
		return "other";
	}

	/** "Sportlov – Huddinge" -> "Sportlov" */
	function cleanSummary(summary) {
		return (summary || "").replace(/\s+[–—-]\s+[^–—-]+$/, "").trim();
	}

	/**
	 * The exclusive-DTEND rule lives here.
	 *
	 * For all-day events DTEND is the first day *after* the event
	 * (RFC 5545 §3.6.1). DTSTART 20270301 / DTEND 20270306 is 1–5 March.
	 * Without DTEND an all-day event lasts one day.
	 */
	function lastDayOf(event) {
		const start = event.dtstart.date;
		const end = event.dtend;
		if (!end) return start;
		if (end.allDay || end.time === "000000") {
			const last = addDays(end.date, -1);
			return last < start ? start : last;
		}
		return end.date < start ? start : end.date;
	}

	function toHolidays(events) {
		return events
			.filter((e) => e.dtstart && e.dtstart.date && (e.status || "").toUpperCase() !== "CANCELLED")
			.map((e) => {
				const type = classify(e);
				const meta = TYPES[type];
				const start = e.dtstart.date;
				const lastDay = lastDayOf(e);
				const cleaned = cleanSummary(e.summary);
				// skollov.nu only publishes the first day of summer, as a one-day event.
				// It is a start marker, not a one-day holiday: no end to count towards.
				const openEnded = lastDay === start && (type === "summer" || /börjar/i.test(e.summary || ""));
				let name = meta ? meta.name : cleaned || "Lov";
				// Keep the source's own word if it differs (e.g. "Vinterlov" for sportlov).
				if (meta && type !== "summer" && /lov$/i.test(cleaned) && cleaned.toLowerCase() !== meta.name.toLowerCase()) {
					name = cleaned;
				}
				return {
					uid: e.uid || null,
					type,
					name,
					emoji: meta ? meta.emoji : FALLBACK_EMOJI,
					start,
					lastDay,
					openEnded,
					summary: e.summary || ""
				};
			})
			.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
	}

	/* ----------------------------------------------------------------- view */

	/**
	 * The first actually free day of a holiday.
	 *
	 * When a lov starts on a Monday the last school day is the Friday before,
	 * so the family is free from Saturday. Counting down to the Monday would
	 * leave the weekend belonging to no state at all, so the countdown, the
	 * "during" state and the bar all start from this same adjusted date.
	 */
	function freeFrom(h, includeWeekendBefore) {
		return includeWeekendBefore && weekday(h.start) === 1 ? addDays(h.start, -2) : h.start;
	}

	const VIEW_DEFAULTS = {
		maxUpcoming: 3,
		includeWeekendBefore: true,
		summerSunUntil: "08-20",
		staleWarningDays: 30
	};

	/**
	 * Decide what the mirror should show on `today` ("YYYY-MM-DD", Stockholm).
	 *
	 * Returns { state, current, next, upcoming, staleWarning, lastDataDay }:
	 *   "before"  a holiday lies ahead; `next` is it (countdown).
	 *   "during"  today is inside a bounded holiday; `current` is it.
	 *   "summer"  the summer-start marker has been reached and nothing newer is
	 *             in the data. This is the big sun. It lasts until
	 *             `summerSunUntil` (MM-DD, in the marker's year) — after that
	 *             school has restarted and missing data is a real problem.
	 *   "none"    nothing current or ahead: the calendar has run out.
	 *
	 * Every holiday returned carries `freeFrom`, the date counted towards.
	 * The decision depends only on dates in the data, never on fetch status,
	 * so a failed fetch can never produce a sun.
	 */
	function computeView(holidays, today, options) {
		const opts = Object.assign({}, VIEW_DEFAULTS, options || {});
		const list = (holidays || [])
			.map((h) => Object.assign({}, h, { freeFrom: freeFrom(h, opts.includeWeekendBefore) }))
			.sort((a, b) => (a.freeFrom < b.freeFrom ? -1 : a.freeFrom > b.freeFrom ? 1 : 0));

		const lastDataDay = list.reduce((max, h) => (max === null || h.lastDay > max ? h.lastDay : max), null);
		const last = list.find((h) => h.lastDay === lastDataDay) || null;

		const current = list.find((h) => !h.openEnded && h.freeFrom <= today && today <= h.lastDay) || null;
		const future = list.filter((h) => h.freeFrom > today);
		const max = Math.max(0, opts.maxUpcoming);

		if (current) {
			return finish("during", current, null, future.slice(0, max));
		}
		if (future.length > 0) {
			return finish("before", null, future[0], future.slice(1, 1 + max));
		}
		// Nothing ahead. A sun if the data ended with summer starting and school
		// has not restarted yet; otherwise the calendar has simply run out.
		if (last && last.openEnded && last.freeFrom <= today) {
			const cutoff = `${last.start.slice(0, 4)}-${opts.summerSunUntil}`;
			if (today <= cutoff) return finish("summer", last, null, []);
		}
		return finish("none", null, null, []);

		function finish(state, cur, next, upcoming) {
			// Warn ahead of time only when the data will run out *without* a summer
			// to cover the gap; a calendar ending in "Sommarlovet börjar" is the
			// normal shape and the sun handles it.
			const endsInSummer = last && last.openEnded;
			const staleWarning =
				(state === "before" || state === "during") &&
				!endsInSummer &&
				lastDataDay !== null &&
				diffDays(today, lastDataDay) <= opts.staleWarningDays;
			return { state, current: cur, next, upcoming, staleWarning, lastDataDay };
		}
	}

	/* -------------------------------------------------------------- the bar */

	/**
	 * Above this many days the bar is drawn continuous instead of one segment
	 * per day. At a typical MagicMirror column width (~300–400 px) 14 segments
	 * with small gaps are still ~20 px blocks you can count from across a room;
	 * jullov (~25 days) would be slivers, and nobody counts 25 blocks anyway.
	 * Two weeks is also where "how many days" stops being something you see
	 * and becomes something you read — which the big number already does.
	 */
	const MAX_SEGMENTS = 14;

	/**
	 * Remaining-days bar for a bounded holiday.
	 * Day i of the holiday is segment i; days already over are dark, today and
	 * the days after it are lit. First day: all lit. Last day: exactly one.
	 * Full width is constant so the proportion stays visible.
	 */
	function barModel(h, today) {
		const total = diffDays(h.freeFrom, h.lastDay) + 1;
		const remaining = Math.min(total, Math.max(0, diffDays(today, h.lastDay) + 1));
		const elapsed = total - remaining;
		const segmented = total <= MAX_SEGMENTS;
		return {
			total,
			remaining,
			segmented,
			segments: segmented ? Array.from({ length: total }, (_, i) => i >= elapsed) : null,
			litFraction: total > 0 ? remaining / total : 0
		};
	}

	/* ------------------------------------------------------------- phrasing */

	const WEEKDAYS = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];
	const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
	const MONTHS_SHORT = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

	function capitalize(s) {
		return s.charAt(0).toUpperCase() + s.slice(1);
	}

	/** "jullovet", "sommarlovet"; anything not ending in -lov is just lowercased. */
	function definite(name) {
		const lower = name.toLowerCase();
		return /lov$/.test(lower) ? `${lower}et` : lower;
	}

	/** "fredag 18 december" */
	function formatLong(dateStr) {
		const [, m, d] = dateStr.split("-").map(Number);
		return `${WEEKDAYS[weekday(dateStr)]} ${d} ${MONTHS[m - 1]}`;
	}

	/** "18 dec" */
	function formatShort(dateStr) {
		const [, m, d] = dateStr.split("-").map(Number);
		return `${d} ${MONTHS_SHORT[m - 1]}`;
	}

	/**
	 * Waiting state. The number is the hero; `line` says what it counts.
	 * `h` must come from computeView (it needs `freeFrom`).
	 * Returns { big, line, sub, days }.
	 */
	function phraseBefore(h, today) {
		const days = diffDays(today, h.freeFrom);
		const def = definite(h.name);
		const sub = `Ledigt från ${formatLong(h.freeFrom)}`;
		if (days === 1) {
			return { big: "1", line: `dag kvar – imorgon är det ${h.name.toLowerCase()}! 🎉`, sub, days };
		}
		let line = `dagar kvar till ${def}`;
		line += days <= 6 ? ` – på ${WEEKDAYS[weekday(h.freeFrom)]}!` : "!";
		return { big: String(days), line, sub, days };
	}

	/**
	 * Holiday state. The big number is days *left of the holiday*, today
	 * included, and the copy says so ("lovdagar kvar") so it cannot be read
	 * as a countdown. Returns { banner, big, line, sub, remaining }.
	 */
	function phraseDuring(h, today) {
		const remaining = diffDays(today, h.lastDay) + 1;
		const name = h.name.toLowerCase();
		const banner = today === h.freeFrom ? `Äntligen ${name}!` : `Det är ${name}!`;
		let line = "lovdagar kvar";
		if (remaining === 1) line = "lovdag kvar – sista dagen! 🥳";
		else if (remaining === 2) line = "lovdagar kvar – imorgon är sista dagen";
		return { banner, big: String(remaining), line, sub: `Ledigt t.o.m. ${formatLong(h.lastDay)}`, remaining };
	}

	/** The sun. Returns { title, line }. */
	function phraseSummer(h, today) {
		if (today === h.freeFrom) {
			return { title: `Idag börjar ${definite(h.name)}!`, line: "Äntligen – njut av ledigheten! 🥳" };
		}
		return { title: "Glad sommar!", line: "Sommarlovet är här – njut av ledigheten 🌊" };
	}

	/** Upcoming list wording, countdown-framed: "om 128 dagar", "imorgon", "på lördag". */
	function phraseUntil(h, today) {
		const days = diffDays(today, h.freeFrom);
		if (days === 1) return "imorgon";
		if (days < 7) return `på ${WEEKDAYS[weekday(h.freeFrom)]}`;
		return `om ${days} dagar`;
	}

	/** Today's date as "YYYY-MM-DD" in the given IANA time zone (default Stockholm). */
	function todayIn(timeZone, now) {
		const date = now || new Date();
		try {
			// en-CA formats as YYYY-MM-DD.
			return new Intl.DateTimeFormat("en-CA", {
				timeZone: timeZone || "Europe/Stockholm",
				year: "numeric",
				month: "2-digit",
				day: "2-digit"
			}).format(date);
		} catch {
			return localDateString(date);
		}
	}

	/** "huddinge" from "Huddinge", "Upplands Väsby" -> "upplands-vasby" (skollov.nu's slugs). */
	function slugify(kommun) {
		return String(kommun || "")
			.trim()
			.toLowerCase()
			.replace(/[åä]/g, "a")
			.replace(/ö/g, "o")
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
	}

	return {
		addDays,
		diffDays,
		weekday,
		localDateString,
		parseICS,
		toHolidays,
		lastDayOf,
		freeFrom,
		computeView,
		barModel,
		MAX_SEGMENTS,
		phraseBefore,
		phraseDuring,
		phraseSummer,
		phraseUntil,
		todayIn,
		formatLong,
		formatShort,
		definite,
		slugify,
		TYPES
	};
});
