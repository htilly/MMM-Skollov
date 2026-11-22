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

test("remaining-days count uses the exclusive end", () => {
	// Sportlov 1–5 March: on Monday 1 March, 5 days remain (including today).
	const t = core.phraseDuring(byType.sport, "2027-03-01");
	assert.equal(t.big, "5");
	assert.equal(core.phraseDuring(byType.sport, "2027-03-04").big, "2");
	assert.equal(core.phraseDuring(byType.sport, "2027-03-05").big, "Sista lovdagen!");
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

/* ------------------------------------------------------- display states */

test("state: before a holiday counts down to the next one", () => {
	const v = core.computeView(holidays, "2026-11-22", { maxUpcoming: 3 });
	assert.equal(v.state, "before");
	assert.equal(v.next.type, "christmas");
	assert.deepEqual(
		v.upcoming.map((h) => h.type),
		["sport", "easter", "summer"]
	);
	const t = core.phraseBefore(v.next, "2026-11-22");
	assert.equal(t.big, "26");
	assert.equal(t.unit, "dagar");
	assert.equal(t.line, "kvar till jullovet!");
	assert.equal(t.sub, "Fredag 18 december");
	assert.equal(v.staleWarning, false);
});

test("state: before — proximity phrasing", () => {
	// Sportlov starts Monday 1 March 2027.
	const tomorrow = core.phraseBefore(byType.sport, "2027-02-28");
	assert.equal(tomorrow.big, "Imorgon");
	assert.equal(tomorrow.line, "är det sportlov! 🎉");
	const friday = core.phraseBefore(byType.sport, "2027-02-26");
	assert.equal(friday.big, "3");
	assert.equal(friday.line, "kvar till sportlovet – på måndag!");
	assert.equal(core.phraseBefore(byType.sport, "2027-02-14").line, "kvar till sportlovet!");
	assert.equal(core.phraseUntil(byType.sport, "2027-02-28"), "imorgon");
	assert.equal(core.phraseUntil(byType.sport, "2027-02-26"), "på måndag");
	assert.equal(core.phraseUntil(byType.sport, "2027-02-14"), "om 15 dagar");
});

test("state: during a holiday shows days remaining and the next ones", () => {
	const v = core.computeView(holidays, "2027-03-03", { maxUpcoming: 2 });
	assert.equal(v.state, "during");
	assert.equal(v.current.type, "sport");
	assert.equal(v.next, null);
	assert.deepEqual(
		v.upcoming.map((h) => h.type),
		["easter", "summer"]
	);
	const t = core.phraseDuring(v.current, "2027-03-03");
	assert.equal(t.banner, "Det är sportlov!");
	assert.equal(t.big, "3");
	assert.equal(t.unit, "lovdagar kvar");
	assert.equal(t.line, "Ledigt t.o.m. fredag 5 mars");
	assert.equal(core.phraseDuring(v.current, "2027-03-01").banner, "Idag börjar sportlovet!");
});

test("state: during — jullov spans the new year", () => {
	const v = core.computeView(holidays, "2027-01-01");
	assert.equal(v.state, "during");
	assert.equal(v.current.type, "christmas");
	assert.equal(core.phraseDuring(v.current, "2027-01-01").big, "11");
});

test("state: during — summer is open-ended and shown for summerGreetingDays", () => {
	const first = core.computeView(holidays, "2027-06-10");
	assert.equal(first.state, "during");
	assert.equal(core.phraseDuring(first.current, "2027-06-10").banner, "Idag börjar sommarlovet!");
	assert.equal(core.phraseDuring(first.current, "2027-06-10").progress, null);
	assert.equal(core.computeView(holidays, "2027-07-15").state, "during");
	// 10 June + 70 days - 1 = 18 Aug is the last greeting day.
	assert.equal(core.computeView(holidays, "2027-08-18", { summerGreetingDays: 70 }).state, "during");
	assert.equal(core.computeView(holidays, "2027-08-19", { summerGreetingDays: 70 }).state, "none");
	assert.equal(core.computeView(holidays, "2027-06-12", { summerGreetingDays: 1 }).state, "none");
});

test("state: none when the data has run out", () => {
	const v = core.computeView(holidays, "2027-09-01");
	assert.equal(v.state, "none");
	assert.equal(v.current, null);
	assert.equal(v.next, null);
	assert.deepEqual(v.upcoming, []);
	assert.equal(core.computeView([], "2027-01-01").state, "none");
});

test("stale warning when the last event is within the threshold", () => {
	// Last known date is 10 June 2027.
	assert.equal(core.computeView(holidays, "2027-05-10", { staleWarningDays: 30 }).staleWarning, false);
	assert.equal(core.computeView(holidays, "2027-05-11", { staleWarningDays: 30 }).staleWarning, true);
	assert.equal(core.computeView(holidays, "2027-06-20").staleWarning, true);
	// In the none state the main message already says it; no duplicate warning.
	assert.equal(core.computeView(holidays, "2027-09-01").staleWarning, false);
});

test("maxUpcoming limits the list, 0 hides it", () => {
	assert.equal(core.computeView(holidays, "2026-11-22", { maxUpcoming: 1 }).upcoming.length, 1);
	assert.equal(core.computeView(holidays, "2026-11-22", { maxUpcoming: 0 }).upcoming.length, 0);
});

test("slugify matches skollov.nu slugs", () => {
	assert.equal(core.slugify("Huddinge"), "huddinge");
	assert.equal(core.slugify("Upplands Väsby"), "upplands-vasby");
	assert.equal(core.slugify("Göteborg"), "goteborg");
	assert.equal(core.slugify(" Malmö "), "malmo");
});
