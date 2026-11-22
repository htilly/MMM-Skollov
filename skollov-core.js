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
				const openEnded = type === "summer" && lastDay === start;
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
	 * Decide what the mirror should show on `today`.
	 *
	 * Returns { state, current, next, upcoming, staleWarning, lastDataDay }
	 *   state "during": today is inside a holiday (or inside the summer
	 *                   greeting window after "Sommarlovet börjar")
	 *   state "before": a holiday lies ahead; `next` is it
	 *   state "none":   nothing current or ahead in the data
	 */
	function computeView(holidays, today, options) {
		const opts = Object.assign({ maxUpcoming: 3, staleWarningDays: 30, summerGreetingDays: 70 }, options || {});
		const list = (holidays || []).slice().sort((a, b) => (a.start < b.start ? -1 : 1));

		const effectiveLast = (h) => (h.openEnded ? addDays(h.start, Math.max(1, opts.summerGreetingDays) - 1) : h.lastDay);

		const current = list.find((h) => h.start <= today && today <= effectiveLast(h)) || null;
		const future = list.filter((h) => h.start > today);
		const next = current ? null : future[0] || null;

		const upcomingFrom = current ? future : future.slice(1);
		const upcoming = upcomingFrom.slice(0, Math.max(0, opts.maxUpcoming));

		// The last date the data actually knows about. For the open-ended
		// summer marker that is its start: nothing is known after it.
		const lastDataDay = list.length ? list.reduce((max, h) => (h.lastDay > max ? h.lastDay : max), list[0].lastDay) : null;

		let state = "none";
		if (current) state = "during";
		else if (next) state = "before";

		const staleWarning = state !== "none" && lastDataDay !== null && diffDays(today, lastDataDay) <= opts.staleWarningDays;

		return { state, current, next, upcoming, staleWarning, lastDataDay };
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

	function formatRange(h) {
		if (h.openEnded) return `från ${formatShort(h.start)}`;
		if (h.start === h.lastDay) return formatShort(h.start);
		return `${formatShort(h.start)} – ${formatShort(h.lastDay)}`;
	}

	function plural(n, one, many) {
		return n === 1 ? one : many;
	}

	/**
	 * Copy for the waiting state.
	 * Returns { big, unit, line, sub } — `big` is the hero number or word.
	 */
	function phraseBefore(h, today) {
		const days = diffDays(today, h.start);
		const def = definite(h.name);
		const sub = h.openEnded ? `${capitalize(def)} börjar ${formatLong(h.start)}` : capitalize(formatLong(h.start));
		if (days === 1) {
			return { big: "Imorgon", unit: "", line: `är det ${h.name.toLowerCase()}! 🎉`, sub, days };
		}
		let line = `kvar till ${def}`;
		if (days <= 6) line += ` – på ${WEEKDAYS[weekday(h.start)]}!`;
		else line += "!";
		return { big: String(days), unit: plural(days, "dag", "dagar"), line, sub, days };
	}

	/**
	 * Copy for the holiday itself. Remaining days count today.
	 * Returns { banner, big, unit, line, sub, progress }.
	 */
	function phraseDuring(h, today) {
		const def = definite(h.name);
		if (h.openEnded) {
			const started = h.start === today;
			return {
				banner: started ? `Idag börjar ${def}!` : `Det är ${h.name.toLowerCase()}!`,
				big: "Glad sommar!",
				unit: "",
				line: started ? "Äntligen – njut av ledigheten 🥳" : "Njut av ledigheten 🌊",
				sub: null,
				progress: null
			};
		}
		const total = diffDays(h.start, h.lastDay) + 1;
		const remaining = diffDays(today, h.lastDay) + 1;
		const progress = Math.min(1, Math.max(0, (total - remaining + 1) / total));
		const banner = h.start === today ? `Idag börjar ${def}!` : `Det är ${h.name.toLowerCase()}!`;
		if (remaining === 1) {
			return { banner, big: "Sista lovdagen!", unit: "", line: "Gör något roligt idag 🥳", sub: null, progress, remaining };
		}
		return {
			banner,
			big: String(remaining),
			unit: "lovdagar kvar",
			line: remaining === 2 ? "Imorgon är sista lovdagen" : `Ledigt t.o.m. ${formatLong(h.lastDay)}`,
			sub: null,
			progress,
			remaining
		};
	}

	/** Short "om 3 dagar" / "imorgon" for the upcoming list. */
	function phraseUntil(h, today) {
		const days = diffDays(today, h.start);
		if (days === 1) return "imorgon";
		if (days < 7) return `på ${WEEKDAYS[weekday(h.start)]}`;
		return `om ${days} dagar`;
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
		computeView,
		phraseBefore,
		phraseDuring,
		phraseUntil,
		formatLong,
		formatShort,
		formatRange,
		definite,
		slugify,
		TYPES
	};
});
