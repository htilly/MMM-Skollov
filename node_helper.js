/* MMM-Skollov node helper — owns all network and disk access.
 *
 * One feed per kommun, shared by every browser client and module instance.
 * Polling is deliberately slow: the data changes about once a year.
 */
"use strict";

const NodeHelper = require("node_helper");
const path = require("node:path");
let Log;
try {
	Log = require("logger"); // MagicMirror >= 2.14
} catch {
	Log = console;
}
const feed = require("./lib/feed.js");
const core = require("./skollov-core.js");

const HOUR = 60 * 60 * 1000;
const MIN_INTERVAL = 12 * HOUR; // never more than twice a day
const COLD_START_RETRY = 1 * HOUR; // only when there is no cache at all

module.exports = NodeHelper.create({
	start() {
		this.feeds = {};
	},

	cacheFile(slug) {
		return path.join(__dirname, "cache", `${slug}.json`);
	},

	async socketNotificationReceived(notification, payload) {
		if (notification !== "SKOLLOV_SUBSCRIBE") return;

		const slug = core.slugify(payload.kommun);
		if (!slug) {
			this.sendSocketNotification("SKOLLOV_DATA", { kommun: "", holidays: [], error: { message: "No kommun configured" } });
			return;
		}
		const interval = Math.max(MIN_INTERVAL, Number(payload.updateInterval) || 0);

		let f = this.feeds[slug];
		if (!f) {
			f = this.feeds[slug] = { slug, url: payload.calendarUrl || null, interval, timer: null, data: null };
			f.data = await feed.readCache(this.cacheFile(slug));
		} else {
			f.interval = Math.min(f.interval, interval);
		}

		// Serve what we have straight away; a fresh client should not wait for the network.
		if (f.data) this.sendSocketNotification("SKOLLOV_DATA", f.data);
		if (!f.timer) this.schedule(f);
	},

	schedule(f) {
		const last = f.data && f.data.lastAttemptAt ? f.data.lastAttemptAt : 0;
		const hasData = f.data && f.data.holidays && f.data.holidays.length > 0;
		const wait = hasData || !last ? f.interval : COLD_START_RETRY;
		const delay = Math.max(0, last + wait - Date.now());
		f.timer = setTimeout(() => this.run(f), delay);
	},

	async run(f) {
		f.timer = null;
		f.data = await feed.refresh({ slug: f.slug, url: f.url, cacheFile: this.cacheFile(f.slug) });
		if (f.data.error) {
			Log.warn(`[MMM-Skollov] ${f.slug}: fetch failed (${f.data.error.message}); serving ${f.data.holidays.length} cached holidays`);
		} else {
			Log.info(`[MMM-Skollov] ${f.slug}: fetched ${f.data.holidays.length} holidays`);
		}
		this.sendSocketNotification("SKOLLOV_DATA", f.data);
		this.schedule(f);
	},

	stop() {
		for (const f of Object.values(this.feeds)) clearTimeout(f.timer);
	}
});
