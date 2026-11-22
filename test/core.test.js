"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../skollov-core.js");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "huddinge-2026-2027.ics"), "utf8");
const holidays = core.toHolidays(core.parseICS(fixture).events);
const byType = Object.fromEntries(holidays.map((h) => [h.type, h]));

/* ------------------------------------------------------ DTEND is exclusive */

test("all-day DTEND is exclusive: real Huddinge data", () => {
	// DTSTART 20261026 / DTEND 20261031 -> 26–30 Oct
	assert.equal(byType.autumn.start, "2026-10-26");
	assert.equal(byType.autumn.lastDay, "2026-10-30");
	// DTSTART 20270301 / DTEND 20270306 -> 1–5 March
	assert.equal(byType.sport.start, "2027-03-01");
	assert.equal(byType.sport.lastDay, "2027-03-05");
	// Across the year boundary: DTEND 20270112 -> last day 11 Jan
	assert.equal(byType.christmas.lastDay, "2027-01-11");
	// DTEND 20270403 -> last day 2 April
	assert.equal(byType.easter.lastDay, "2027-04-02");
});

test("all-day DTEND is exclusive: the DTEND date itself is not a holiday", () => {
	assert.equal(core.computeView(holidays, "2027-03-05").state, "during");
	const after = core.computeView(holidays, "2027-03-06");
	assert.equal(after.state, "before");
	assert.equal(after.next.type, "easter");
});

test("all-day DTEND is exclusive: month and leap-year boundaries", () => {
	const ev = (s, e) => ({ dtstart: { date: s, allDay: true }, dtend: e && { date: e, allDay: true } });
	assert.equal(core.lastDayOf(ev("2028-02-27", "2028-03-01")), "2028-02-29");
	assert.equal(core.lastDayOf(ev("2027-02-27", "2027-03-01")), "2027-02-28");
	assert.equal(core.lastDayOf(ev("2026-12-28", "2027-01-01")), "2026-12-31");
	// No DTEND: one day. Single-day event: DTEND = next day.
	assert.equal(core.lastDayOf(ev("2027-06-10")), "2027-06-10");
	assert.equal(core.lastDayOf(ev("2027-06-10", "2027-06-11")), "2027-06-10");
});

/* -------------------------------------------------------------- parsing */

test("parses the real feed: five holidays, names, emoji, calendar name", () => {
	const cal = core.parseICS(fixture);
	assert.equal(cal.name, "Skollov Huddinge 2026/2027");
	assert.deepEqual(
		holidays.map((h) => [h.type, h.name, h.emoji]),
		[
			["autumn", "Höstlov", "🍂"],
			["christmas", "Jullov", "🎄"],
			["sport", "Sportlov", "⛷️"],
			["easter", "Påsklov", "🐣"],
			["summer", "Sommarlov", "☀️"]
		]
	);
	assert.equal(byType.summer.openEnded, true);
	assert.equal(byType.sport.openEnded, false);
});

test("handles LF endings, folded lines, escapes, and summary-only classification", () => {
	const ics = [
		"BEGIN:VCALENDAR",
		"BEGIN:VEVENT",
		"DTSTART;VALUE=DATE:20270215",
		"DTEND;VALUE=DATE:20270220",
		"SUMMARY:Vinter",
		" lov – Testby",
		"DESCRIPTION:Rad ett\\nrad två\\, med komma",
		"END:VEVENT",
		"END:VCALENDAR"
	].join("\n");
	const cal = core.parseICS(ics);
	assert.equal(cal.events[0].summary, "Vinterlov – Testby");
	assert.equal(cal.events[0].description, "Rad ett\nrad två, med komma");
	const [h] = core.toHolidays(cal.events);
	assert.equal(h.type, "sport");
	assert.equal(h.name, "Vinterlov");
	assert.equal(h.emoji, "⛷️");
	assert.equal(h.lastDay, "2027-02-19");
});

test("rejects non-calendar input", () => {
	assert.throws(() => core.parseICS("Kommunen hittades inte."));
});

/* ------------------------------------------- first free day (weekend rule) */

const view = (today, opts) => core.computeView(holidays, today, opts);
const vh = (type, opts) => core.computeView(holidays, "2026-08-01", Object.assign({ maxUpcoming: 9 }, opts)).upcoming.concat(
	core.computeView(holidays, "2026-08-01", opts).next
).find((h) => h.type === type);

test("countdown targets the first free day: Monday starts move to the Saturday", () => {
	// htilly's table for Huddinge 2026/2027.
	assert.equal(vh("autumn").freeFrom, "2026-10-24"); // mån 26/10 -> lör 24/10
	assert.equal(vh("christmas").freeFrom, "2026-12-18"); // fredag, oförändrat
	assert.equal(vh("sport").freeFrom, "2027-02-27"); // mån 1/3 -> lör 27/2
	assert.equal(vh("easter").freeFrom, "2027-03-30"); // tisdag, oförändrat
	assert.equal(vh("summer").freeFrom, "2027-06-10"); // torsdag, oförändrat
});

test("weekend rule can be switched off", () => {
	const off = { includeWeekendBefore: false };
	assert.equal(vh("autumn", off).freeFrom, "2026-10-26");
	assert.equal(vh("sport", off).freeFrom, "2027-03-01");
	assert.equal(view("2027-02-27", off).state, "before");
	assert.equal(core.phraseBefore(view("2027-02-27", off).next, "2027-02-27").big, "2");
});

test("no gap: the weekend before a Monday start is part of the lov", () => {
	for (const day of ["2027-02-27", "2027-02-28", "2027-03-01"]) {
		const v = view(day);
		assert.equal(v.state, "during", day);
		assert.equal(v.current.type, "sport", day);
	}
	// Friday before: one day left of the countdown, never "0 dagar".
	const fri = view("2027-02-26");
	assert.equal(fri.state, "before");
	assert.equal(core.phraseBefore(fri.next, "2027-02-26").big, "1");
});

/* ------------------------------------------------------- display states */

test("state: before — counts down in days to the next lov", () => {
	const v = view("2026-11-22", { maxUpcoming: 3 });
	assert.equal(v.state, "before");
	assert.equal(v.next.type, "christmas");
	const t = core.phraseBefore(v.next, "2026-11-22");
	assert.equal(t.big, "26");
	assert.equal(t.line, "dagar kvar till jullovet!");
	assert.equal(t.sub, "Ledigt från fredag 18 december");
	assert.equal(v.staleWarning, false);
});

test("state: before — proximity phrasing targets the free day", () => {
	const sport = view("2027-02-20").next;
	assert.equal(sport.type, "sport");
	assert.deepEqual(
		[core.phraseBefore(sport, "2027-02-26").big, core.phraseBefore(sport, "2027-02-26").line],
		["1", "dag kvar – imorgon är det sportlov! 🎉"]
	);
	assert.equal(core.phraseBefore(sport, "2027-02-24").line, "dagar kvar till sportlovet – på lördag!");
	assert.equal(core.phraseBefore(sport, "2027-02-14").line, "dagar kvar till sportlovet!");
	assert.equal(core.phraseBefore(sport, "2027-02-14").big, "13");
});

test("upcoming list is countdown-framed, not dated", () => {
	const v = view("2026-11-22", { maxUpcoming: 3 });
	assert.deepEqual(
		v.upcoming.map((h) => `${h.name} ${core.phraseUntil(h, "2026-11-22")}`),
		["Sportlov om 97 dagar", "Påsklov om 128 dagar", "Sommarlov om 200 dagar"]
	);
	const sport = v.upcoming[0];
	assert.equal(core.phraseUntil(sport, "2027-02-26"), "imorgon");
	assert.equal(core.phraseUntil(sport, "2027-02-24"), "på lördag");
	assert.equal(view("2026-11-22", { maxUpcoming: 0 }).upcoming.length, 0);
});

test("state: during — big number is lovdagar kvar, today included", () => {
	const v = view("2027-03-03", { maxUpcoming: 2 });
	assert.equal(v.state, "during");
	assert.equal(v.current.type, "sport");
	assert.deepEqual(
		v.upcoming.map((h) => h.type),
		["easter", "summer"]
	);
	const t = core.phraseDuring(v.current, "2027-03-03");
	assert.equal(t.banner, "Det är sportlov!");
	assert.equal(t.big, "3");
	assert.equal(t.line, "lovdagar kvar");
	assert.equal(t.sub, "Ledigt t.o.m. fredag 5 mars");
	assert.equal(core.phraseDuring(v.current, "2027-02-27").banner, "Äntligen sportlov!");
	assert.equal(core.phraseDuring(v.current, "2027-02-27").big, "7");
	assert.equal(core.phraseDuring(v.current, "2027-03-04").line, "lovdagar kvar – imorgon är sista dagen");
	assert.equal(core.phraseDuring(v.current, "2027-03-05").big, "1");
	assert.match(core.phraseDuring(v.current, "2027-03-05").line, /^lovdag kvar – sista dagen/);
});

test("state: during ends on the last day; the DTEND date is not a lov day", () => {
	assert.equal(view("2027-03-05").state, "during");
	const after = view("2027-03-06");
	assert.equal(after.state, "before");
	assert.equal(after.next.type, "easter");
});

test("state: during — jullov spans the new year", () => {
	const v = view("2027-01-01");
	assert.equal(v.current.type, "christmas");
	assert.equal(core.phraseDuring(v.current, "2027-01-01").big, "11");
});

/* -------------------------------------------------------------- the bar */

test("bar: sportlov is seven segments (Sat–Fri), all lit on day one", () => {
	const sport = view("2027-02-27").current;
	const first = core.barModel(sport, "2027-02-27");
	assert.equal(first.segmented, true);
	assert.equal(first.total, 7);
	assert.deepEqual(first.segments, [true, true, true, true, true, true, true]);
});

test("bar: one segment goes dark per day, exactly one lit on the last day", () => {
	const sport = view("2027-02-27").current;
	assert.deepEqual(core.barModel(sport, "2027-03-01").segments, [false, false, true, true, true, true, true]);
	const last = core.barModel(sport, "2027-03-05");
	assert.equal(last.remaining, 1);
	assert.deepEqual(last.segments, [false, false, false, false, false, false, true]);
	// Lit count always equals the big number.
	for (let d = 0; d < 7; d++) {
		const day = core.addDays("2027-02-27", d);
		const lit = core.barModel(sport, day).segments.filter(Boolean).length;
		assert.equal(String(lit), core.phraseDuring(sport, day).big, day);
	}
});

test("bar: without the weekend rule sportlov is five segments", () => {
	const sport = view("2027-03-01", { includeWeekendBefore: false }).current;
	assert.equal(core.barModel(sport, "2027-03-01").total, 5);
});

test("bar: long holidays switch to a continuous bar", () => {
	const jul = view("2027-01-01").current;
	const bar = core.barModel(jul, "2027-01-01");
	assert.equal(bar.total, 25); // 18 Dec – 11 Jan
	assert.equal(bar.segmented, false);
	assert.equal(bar.segments, null);
	assert.equal(bar.remaining, 11);
	assert.equal(bar.litFraction, 11 / 25);
	assert.equal(core.barModel(jul, "2026-12-18").litFraction, 1);
	assert.equal(core.barModel(jul, "2027-01-11").litFraction, 1 / 25);
	// The threshold is inclusive.
	const two = { freeFrom: "2027-01-01", lastDay: core.addDays("2027-01-01", core.MAX_SEGMENTS - 1) };
	assert.equal(core.barModel(two, "2027-01-01").segmented, true);
	assert.equal(core.barModel({ ...two, lastDay: core.addDays(two.lastDay, 1) }, "2027-01-01").segmented, false);
});

/* ------------------------------------------------------- summer and sun */

test("summer start is a marker: countdown to it, then the sun — never '1 dag kvar'", () => {
	const eve = view("2027-06-09");
	assert.equal(eve.state, "before");
	assert.equal(core.phraseBefore(eve.next, "2027-06-09").line, "dag kvar – imorgon är det sommarlov! 🎉");

	const first = view("2027-06-10");
	assert.equal(first.state, "summer");
	assert.equal(first.current.type, "summer");
	assert.equal(core.phraseSummer(first.current, "2027-06-10").title, "Idag börjar sommarlovet!");
	assert.equal(core.phraseSummer(first.current, "2027-07-15").title, "Glad sommar!");
	assert.equal(view("2027-07-15").state, "summer");
});

test("sun lasts until summerSunUntil, then the calendar has run out", () => {
	assert.equal(view("2027-08-20").state, "summer");
	assert.equal(view("2027-08-21").state, "none");
	assert.equal(view("2027-08-11", { summerSunUntil: "08-10" }).state, "none");
	const none = view("2027-09-01");
	assert.equal(none.current, null);
	assert.equal(none.next, null);
	assert.deepEqual(none.upcoming, []);
	assert.equal(core.computeView([], "2027-01-01").state, "none");
});

test("a newly published läsår replaces the sun with a countdown", () => {
	const next = core.toHolidays(
		core.parseICS(
			[
				"BEGIN:VCALENDAR",
				"BEGIN:VEVENT",
				"UID:huddinge-autumn-20271025@skollov.nu",
				"DTSTART;VALUE=DATE:20271025",
				"DTEND;VALUE=DATE:20271030",
				"SUMMARY:Höstlov – Huddinge",
				"END:VEVENT",
				"END:VCALENDAR"
			].join("\r\n")
		).events
	);
	const v = core.computeView(next, "2027-07-15");
	assert.equal(v.state, "before");
	assert.equal(v.next.freeFrom, "2027-10-23");
	assert.equal(core.phraseBefore(v.next, "2027-07-15").big, "100");
});

test("data ending without a summer marker gets no sun, and warns ahead", () => {
	const noSummer = holidays.filter((h) => h.type !== "summer");
	assert.equal(core.computeView(noSummer, "2027-02-01").staleWarning, false);
	assert.equal(core.computeView(noSummer, "2027-03-10").staleWarning, true);
	assert.equal(core.computeView(noSummer, "2027-04-10").state, "none");
	// Normal data ending in summer never shows the advance warning: the sun covers it.
	assert.equal(view("2027-06-01").staleWarning, false);
});

test("one-day marker detection", () => {
	const one = (summary, uid) =>
		core.toHolidays([{ uid, summary, dtstart: { date: "2027-06-10", allDay: true }, dtend: { date: "2027-06-11", allDay: true } }])[0];
	assert.equal(one("Sommarlovet börjar – Huddinge").openEnded, true);
	assert.equal(one("Lovet börjar – Testby").openEnded, true);
	assert.equal(one("Studiedag – Testby").openEnded, false);
	assert.equal(byType.sport.openEnded, false);
});

test("today is computed in Europe/Stockholm", () => {
	// 23:30 UTC on 28 Feb is already 1 March in Stockholm.
	assert.equal(core.todayIn("Europe/Stockholm", new Date("2027-02-28T23:30:00Z")), "2027-03-01");
	assert.equal(core.todayIn("Europe/Stockholm", new Date("2027-07-01T21:59:00Z")), "2027-07-01");
	assert.equal(core.todayIn("Europe/Stockholm", new Date("2027-07-01T22:00:00Z")), "2027-07-02");
});

/* ------------------------------------------------------------ showLength */

test("showLength: lov length in parentheses after the name", () => {
	const on = { showLength: true };
	const v = view("2026-11-22", { maxUpcoming: 3 });
	assert.equal(core.phraseBefore(v.next, "2026-11-22", on).line, "dagar kvar till jullovet (25 dagar)!");
	assert.deepEqual(
		v.upcoming.map((h) => core.displayName(h, on)),
		["Sportlov (7 dagar)", "Påsklov (4 dagar)", "Sommarlov"] // summer has no end: no length
	);
	const sport = v.upcoming[0];
	assert.equal(core.phraseBefore(sport, "2027-02-26", on).line, "dag kvar – imorgon är det sportlov (7 dagar)! 🎉");
	assert.equal(core.phraseBefore(sport, "2027-02-24", on).line, "dagar kvar till sportlovet (7 dagar) – på lördag!");
	assert.equal(core.phraseDuring(sport, "2027-03-02", on).banner, "Det är sportlov (7 dagar)!");
	assert.equal(core.phraseDuring(sport, "2027-02-27", on).banner, "Äntligen sportlov (7 dagar)!");
});

test("showLength: length follows the weekend rule, and is off when not asked for", () => {
	const off = view("2026-11-22", { maxUpcoming: 3, includeWeekendBefore: false });
	assert.equal(core.displayName(off.upcoming[0], { showLength: true }), "Sportlov (5 dagar)");
	assert.equal(core.lengthDays(vh("autumn")), 7); // lör 24 – fre 30 okt
	assert.equal(core.lengthDays(vh("summer")), null);
	assert.equal(core.displayName(vh("sport"), {}), "Sportlov");
	assert.equal(core.phraseBefore(vh("christmas"), "2026-11-22").line, "dagar kvar till jullovet!");
	const one = { name: "Lovdag", openEnded: false, freeFrom: "2027-05-14", lastDay: "2027-05-14" };
	assert.equal(core.displayName(one, { showLength: true }), "Lovdag (1 dag)");
});

test("slugify matches skollov.nu slugs", () => {
	assert.equal(core.slugify("Huddinge"), "huddinge");
	assert.equal(core.slugify("Upplands Väsby"), "upplands-vasby");
	assert.equal(core.slugify("Göteborg"), "goteborg");
	assert.equal(core.slugify(" Malmö "), "malmo");
});
