/* MMM-Skollov — countdown to Swedish school holidays.
 *
 * This is a countdown, not a calendar: the number of days is the hero and
 * everything else supports it. Dates are optional and never lead.
 *
 * Data: https://skollov.nu/kalender/<kommun>.ics, fetched by node_helper.js.
 * Everything shown on the mirror is Swedish; code and comments are English.
 */
/* global Module, SkollovCore */

Module.register("MMM-Skollov", {
	defaults: {
		kommun: "huddinge",
		header: "Skollov 🎒",
		showUpcoming: true,
		maxUpcoming: 3,
		updateInterval: 24 * 60 * 60 * 1000,
		// Count down to the Saturday when a lov starts on a Monday.
		includeWeekendBefore: true,
		// Show the summer sun until this date (MM-DD). Swedish schools restart
		// around week 33–34, varying by kommun; after this date a calendar with
		// no new läsår is a real problem, not a summer, and the module says so.
		summerSunUntil: "08-20",
		staleWarningDays: 30,
		cacheWarningDays: 3,
		showDates: false,
		// Show the lov's length after its name: "jullovet (25 dagar)".
		// Counted from the first free day, like the bar; never for sommarlov.
		showLength: true,
		animate: true,
		timeZone: "Europe/Stockholm",
		calendarUrl: null,
		debugDate: null
	},

	getScripts() {
		return [this.file("skollov-core.js")];
	},

	getStyles() {
		return [this.file("MMM-Skollov.css")];
	},

	getHeader() {
		return this.config.header || this.data.header || "";
	},

	start() {
		this.payload = null;
		this.slug = SkollovCore.slugify(this.config.kommun);
		this.sendSocketNotification("SKOLLOV_SUBSCRIBE", {
			kommun: this.slug,
			updateInterval: this.config.updateInterval,
			calendarUrl: this.config.calendarUrl
		});
		// Re-render once when the date changes in Stockholm. Checking each
		// minute is cheap and avoids timer drift and DST arithmetic.
		this.renderedFor = this.today();
		setInterval(() => {
			const today = this.today();
			if (today !== this.renderedFor) {
				this.renderedFor = today;
				this.updateDom(1000);
			}
		}, 60 * 1000);
	},

	today() {
		if (this.config.debugDate) return this.config.debugDate;
		return SkollovCore.todayIn(this.config.timeZone);
	},

	socketNotificationReceived(notification, payload) {
		if (notification !== "SKOLLOV_DATA" || payload.kommun !== this.slug) return;
		this.payload = payload;
		this.updateDom(this.hasRendered ? 1000 : 0);
		this.hasRendered = true;
	},

	/* ------------------------------------------------------------- render */

	el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined && text !== null) node.textContent = text;
		return node;
	},

	getDom() {
		const root = this.el("div", "skollov");
		const p = this.payload;

		if (!p) {
			root.appendChild(this.el("div", "skollov-message dimmed small", "Hämtar lovdatum… 🎒"));
			return root;
		}

		if (!p.holidays || p.holidays.length === 0) {
			const notFound = p.error && p.error.status === 404;
			root.appendChild(this.el("div", "skollov-message-emoji", "😕"));
			root.appendChild(
				this.el(
					"div",
					"skollov-message small",
					notFound ? `Hittade ingen lovkalender för ”${this.slug}” på skollov.nu.` : "Kunde inte hämta lovdatum från skollov.nu."
				)
			);
			root.appendChild(
				this.el("div", "skollov-message xsmall dimmed", notFound ? "Kontrollera kommun i config." : "Försöker igen om en stund.")
			);
			return root;
		}

		const today = this.today();
		const view = SkollovCore.computeView(p.holidays, today, {
			maxUpcoming: this.config.maxUpcoming,
			includeWeekendBefore: this.config.includeWeekendBefore,
			summerSunUntil: this.config.summerSunUntil,
			staleWarningDays: this.config.staleWarningDays
		});

		root.classList.add(`skollov--${view.state}`);
		if (this.config.animate) root.classList.add("skollov--animate");

		if (view.state === "during") root.appendChild(this.renderDuring(view.current, today));
		else if (view.state === "before") root.appendChild(this.renderBefore(view.next, today));
		else if (view.state === "summer") root.appendChild(this.renderSummer(view.current, today));
		else root.appendChild(this.renderNone());

		if (this.config.showUpcoming && view.upcoming.length > 0) {
			root.appendChild(this.renderUpcoming(view.upcoming, today));
		}

		if (view.staleWarning) {
			root.appendChild(this.el("div", "skollov-warning xsmall", "⚠️ Lovdatum för nästa läsår finns inte på skollov.nu än."));
		}

		const cacheNote = this.cacheNote(p);
		if (cacheNote) root.appendChild(this.el("div", "skollov-warning xsmall", cacheNote));

		return root;
	},

	/** Emoji + big number on one row: the only thing readable from across the room. */
	hero(emoji, big, bounce) {
		const row = this.el("div", "skollov-hero");
		row.appendChild(this.el("span", `skollov-emoji${bounce ? " skollov-emoji--bounce" : ""}`, emoji));
		row.appendChild(this.el("span", "skollov-num bright", big));
		return row;
	},

	renderBefore(h, today) {
		const t = SkollovCore.phraseBefore(h, today, this.config);
		const box = this.el("div", `skollov-main skollov-type-${h.type}`);
		box.appendChild(this.hero(h.emoji, t.big, false));
		box.appendChild(this.el("div", "skollov-line medium normal", t.line));
		if (this.config.showDates) box.appendChild(this.el("div", "skollov-sub xsmall dimmed", t.sub));
		return box;
	},

	renderDuring(h, today) {
		const t = SkollovCore.phraseDuring(h, today, this.config);
		const box = this.el("div", `skollov-main skollov-main--during skollov-type-${h.type}`);
		box.appendChild(this.el("div", "skollov-banner medium", t.banner));
		box.appendChild(this.hero(h.emoji, t.big, true));
		box.appendChild(this.el("div", "skollov-line medium normal", t.line));
		box.appendChild(this.renderBar(SkollovCore.barModel(h, today)));
		if (this.config.showDates) box.appendChild(this.el("div", "skollov-sub xsmall dimmed", t.sub));
		return box;
	},

	/** Remaining-days bar: constant full width, elapsed days dark, remaining lit. */
	renderBar(bar) {
		const label = `${bar.remaining} av ${bar.total} lovdagar kvar`;
		if (bar.segmented) {
			const wrap = this.el("div", "skollov-bar skollov-bar--segments");
			wrap.setAttribute("role", "img");
			wrap.setAttribute("aria-label", label);
			for (const lit of bar.segments) wrap.appendChild(this.el("span", `skollov-seg${lit ? " skollov-seg--lit" : ""}`));
			return wrap;
		}
		const wrap = this.el("div", "skollov-bar skollov-bar--continuous");
		wrap.setAttribute("role", "img");
		wrap.setAttribute("aria-label", label);
		const fill = this.el("span", "skollov-bar-fill");
		// Remaining days sit at the right end, matching the segmented bar.
		fill.style.width = `${(bar.litFraction * 100).toFixed(2)}%`;
		wrap.appendChild(fill);
		return wrap;
	},

	renderSummer(h, today) {
		const t = SkollovCore.phraseSummer(h, today);
		const box = this.el("div", "skollov-main skollov-main--summer");
		box.appendChild(this.el("div", "skollov-sun", "☀️"));
		box.appendChild(this.el("div", "skollov-summer-title bright", t.title));
		box.appendChild(this.el("div", "skollov-line small normal", t.line));
		return box;
	},

	renderNone() {
		const box = this.el("div", "skollov-main skollov-main--none");
		box.appendChild(this.el("div", "skollov-line small bright", "⚠️ Lovkalendern är slut"));
		box.appendChild(
			this.el(
				"div",
				"skollov-sub xsmall dimmed",
				"skollov.nu har inga lovdatum för det nya läsåret än. De dyker upp här av sig själva när de publiceras."
			)
		);
		return box;
	},

	/** Countdown-framed, not dated: "⛷️ Sportlov om 99 dagar". */
	renderUpcoming(list, today) {
		const box = this.el("div", "skollov-upcoming small dimmed");
		for (const h of list) {
			const row = this.el("div", `skollov-up skollov-type-${h.type}`);
			row.appendChild(this.el("span", "skollov-up-emoji", h.emoji));
			row.appendChild(this.el("span", "skollov-up-name", SkollovCore.displayName(h, this.config)));
			row.appendChild(this.el("span", "skollov-up-until", SkollovCore.phraseUntil(h, today)));
			box.appendChild(row);
		}
		return box;
	},

	/** Visible note when skollov.nu has been unreachable for a while and we run on cache. */
	cacheNote(p) {
		if (!p.error || !p.fetchedAt) return null;
		const ageDays = (Date.now() - p.fetchedAt) / (24 * 60 * 60 * 1000);
		if (ageDays < this.config.cacheWarningDays) return null;
		const date = SkollovCore.formatShort(SkollovCore.todayIn(this.config.timeZone, new Date(p.fetchedAt)));
		return `⚠️ Når inte skollov.nu – visar sparade datum från ${date}.`;
	}
});
