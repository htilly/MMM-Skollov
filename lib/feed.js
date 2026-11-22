/* Fetching and disk caching for one kommun's calendar.
 *
 * Kept separate from node_helper.js so it can be tested without a
 * MagicMirror install. All network and disk access in the module goes
 * through here.
 */
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const core = require("../skollov-core.js");

const USER_AGENT = "MMM-Skollov/1.0 (MagicMirror module; fetches at most twice a day)";
const FETCH_TIMEOUT_MS = 20000;

function calendarUrl(slug) {
	return `https://skollov.nu/kalender/${encodeURIComponent(slug)}.ics`;
}

async function readCache(file) {
	try {
		const data = JSON.parse(await fs.readFile(file, "utf8"));
		return data && Array.isArray(data.holidays) ? data : null;
	} catch {
		return null;
	}
}

async function writeCache(file, data) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(data, null, 2));
	await fs.rename(tmp, file);
}

/** Download and parse. Throws on anything that does not yield holidays. */
async function download(url, fetchImpl) {
	const res = await fetchImpl(url, {
		headers: { "User-Agent": USER_AGENT, Accept: "text/calendar" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	if (!res.ok) {
		const err = new Error(`HTTP ${res.status} from ${url}`);
		err.status = res.status;
		throw err;
	}
	const calendar = core.parseICS(await res.text());
	const holidays = core.toHolidays(calendar.events);
	if (holidays.length === 0) throw new Error("Calendar contained no events");
	return { calendarName: calendar.name, holidays };
}

/**
 * One refresh cycle: try the network, fall back to the cache.
 * Always resolves to the payload the mirror should show, and persists it.
 *
 * The cache records lastAttemptAt even on failure, so a restart loop of
 * MagicMirror cannot turn into a request loop against skollov.nu.
 */
async function refresh({ slug, url, cacheFile, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
	const previous = await readCache(cacheFile);
	const attemptAt = now();
	let payload;
	try {
		const fresh = await download(url || calendarUrl(slug), fetchImpl);
		payload = {
			kommun: slug,
			calendarName: fresh.calendarName,
			holidays: fresh.holidays,
			fetchedAt: attemptAt,
			lastAttemptAt: attemptAt,
			error: null
		};
	} catch (err) {
		payload = {
			kommun: slug,
			calendarName: previous ? previous.calendarName : null,
			holidays: previous ? previous.holidays : [],
			fetchedAt: previous ? previous.fetchedAt : null,
			lastAttemptAt: attemptAt,
			error: { message: err.message, status: err.status || null }
		};
	}
	try {
		await writeCache(cacheFile, payload);
	} catch {
		// A read-only disk should not take the mirror down; the payload is still sent.
	}
	return payload;
}

module.exports = { refresh, readCache, writeCache, download, calendarUrl, USER_AGENT };
