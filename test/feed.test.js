"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const feed = require("../lib/feed.js");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "huddinge-2026-2027.ics"), "utf8");

function tmpCache() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skollov-"));
	return path.join(dir, "cache", "huddinge.json");
}

const ok = (body) => async () => ({ ok: true, status: 200, text: async () => body });
const fail = (status) => async () => ({ ok: false, status, text: async () => "Kommunen hittades inte." });
const offline = async () => {
	throw new Error("getaddrinfo ENOTFOUND skollov.nu");
};

test("successful fetch is parsed, cached and sent with a polite User-Agent", async () => {
	const cacheFile = tmpCache();
	let seen;
	const fetchImpl = async (url, opts) => {
		seen = { url, opts };
		return ok(fixture)();
	};
	const data = await feed.refresh({ slug: "huddinge", cacheFile, fetchImpl, now: () => 1000 });
	assert.equal(seen.url, "https://skollov.nu/kalender/huddinge.ics");
	assert.match(seen.opts.headers["User-Agent"], /^MMM-Skollov\//);
	assert.equal(data.error, null);
	assert.equal(data.holidays.length, 5);
	assert.equal(data.fetchedAt, 1000);
	assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, "utf8")), data);
});

test("a failed fetch serves the cache and records the attempt", async () => {
	const cacheFile = tmpCache();
	await feed.refresh({ slug: "huddinge", cacheFile, fetchImpl: ok(fixture), now: () => 1000 });

	for (const fetchImpl of [offline, fail(503), ok("<html>oops</html>"), ok("BEGIN:VCALENDAR\nEND:VCALENDAR")]) {
		const data = await feed.refresh({ slug: "huddinge", cacheFile, fetchImpl, now: () => 2000 });
		assert.equal(data.holidays.length, 5, "cached holidays survive a bad fetch");
		assert.equal(data.fetchedAt, 1000, "fetchedAt still points at the last good fetch");
		assert.equal(data.lastAttemptAt, 2000);
		assert.ok(data.error);
	}
	const onDisk = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
	assert.equal(onDisk.holidays.length, 5);
});

test("no cache and no network yields an empty payload with the error", async () => {
	const data = await feed.refresh({ slug: "finns-inte", cacheFile: tmpCache(), fetchImpl: fail(404) });
	assert.deepEqual(data.holidays, []);
	assert.equal(data.error.status, 404);
});

test("a failed fetch in March keeps counting down; it never produces a sun", async () => {
	const core = require("../skollov-core.js");
	const cacheFile = tmpCache();
	await feed.refresh({ slug: "huddinge", cacheFile, fetchImpl: ok(fixture), now: () => 1000 });
	const data = await feed.refresh({ slug: "huddinge", cacheFile, fetchImpl: offline, now: () => 2000 });
	assert.ok(data.error);
	const v = core.computeView(data.holidays, "2027-03-10");
	assert.equal(v.state, "before");
	assert.equal(v.next.type, "easter");
});

test("a successful fetch of the next läsår replaces the cache", async () => {
	const cacheFile = tmpCache();
	await feed.refresh({ slug: "huddinge", cacheFile, fetchImpl: ok(fixture), now: () => 1000 });
	const nextYear = fixture.replace(/2026/g, "2027X").replace(/2027(?!X)/g, "2028").replace(/2027X/g, "2027");
	const data = await feed.refresh({ slug: "huddinge", cacheFile, fetchImpl: ok(nextYear), now: () => 2000 });
	assert.equal(data.error, null);
	assert.equal(data.holidays[0].start, "2027-10-26");
	assert.equal(JSON.parse(fs.readFileSync(cacheFile, "utf8")).holidays[0].start, "2027-10-26");
});
