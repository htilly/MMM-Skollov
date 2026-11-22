/* MMM-Skollov — countdown to Swedish school holidays.
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
		staleWarningDays: 30,
		summerGreetingDays: 70,
		cacheWarningDays: 3,
		showDates: true,
		animate: true,
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
		this.scheduleMidnight();
	},

	/** Re-render just after local midnight so the count ticks over with the day. */
	scheduleMidnight() {
		const now = new Date();
		const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 30);
		setTimeout(() => {
			this.updateDom(1000);
			this.scheduleMidnight();
		}, next - now);
	},

	today() {
		if (this.config.debugDate) return this.config.debugDate;
		return SkollovCore.localDateString(new Date());
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
			root.classList.add("skollov--message");
			root.appendChild(this.el("div", "skollov-message dimmed small", "Hämtar lovdatum… 🎒"));
			return root;
		}

		if (!p.holidays || p.holidays.length === 0) {
			root.classList.add("skollov--message");
			const notFound = p.error && p.error.status === 404;
			root.appendChild(this.el("div", "skollov-big-emoji", "😕"));
			root.appendChild(
				this.el(
					"div",
					"skollov-message small",
					notFound ? `Hittade ingen lovkalender för ”${this.slug}” på skollov.nu.` : "Kunde inte hämta lovdatum från skollov.nu."
				)
			);
			root.appendChild(
				this.el("div", "skollov-note xsmall dimmed", notFound ? "Kontrollera kommun i config." : "Försöker igen om en stund.")
			);
			return root;
		}

		const today = this.today();
		const view = SkollovCore.computeView(p.holidays, today, {
			maxUpcoming: this.config.maxUpcoming,
			staleWarningDays: this.config.staleWarningDays,
			summerGreetingDays: this.config.summerGreetingDays
		});

		root.classList.add(`skollov--${view.state}`);
		if (this.config.animate) root.classList.add("skollov--animate");

		if (view.state === "during") root.appendChild(this.renderDuring(view.current, today));
		else if (view.state === "before") root.appendChild(this.renderBefore(view.next, today));
		else root.appendChild(this.renderNone());

		if (this.config.showUpcoming && view.upcoming.length > 0) {
			root.appendChild(this.renderUpcoming(view.upcoming, today));
		}

		if (view.staleWarning) {
			root.appendChild(
				this.el("div", "skollov-warning xsmall", "⚠️ Lovdatum för nästa läsår finns inte på skollov.nu än.")
			);
		}

		const cacheNote = this.cacheNote(p);
		if (cacheNote) root.appendChild(this.el("div", "skollov-warning xsmall", cacheNote));

		return root;
	},

	renderBefore(h, today) {
		const t = SkollovCore.phraseBefore(h, today);
		const hero = this.el("div", `skollov-hero skollov-type-${h.type}`);
		hero.appendChild(this.el("div", "skollov-emoji", h.emoji));
		hero.appendChild(this.el("div", "skollov-name medium bright", h.name));

		const count = this.el("div", "skollov-count");
		count.appendChild(this.el("span", `skollov-num bright${t.unit ? "" : " skollov-num--word"}`, t.big));
		if (t.unit) count.appendChild(this.el("span", "skollov-unit medium", t.unit));
		hero.appendChild(count);

		hero.appendChild(this.el("div", "skollov-line small normal", t.line));
		if (this.config.showDates && t.sub) hero.appendChild(this.el("div", "skollov-sub xsmall dimmed", t.sub));
		return hero;
	},

	renderDuring(h, today) {
		const t = SkollovCore.phraseDuring(h, today);
		const hero = this.el("div", `skollov-hero skollov-hero--during skollov-type-${h.type}`);

		const banner = this.el("div", "skollov-banner");
		banner.appendChild(this.el("span", "skollov-emoji skollov-emoji--bounce", h.emoji));
		banner.appendChild(this.el("span", "skollov-banner-text medium bright", t.banner));
		banner.appendChild(this.el("span", "skollov-emoji skollov-emoji--bounce skollov-emoji--late", h.emoji));
		hero.appendChild(banner);

		const count = this.el("div", "skollov-count");
		count.appendChild(this.el("span", `skollov-num bright${t.unit ? "" : " skollov-num--word"}`, t.big));
		if (t.unit) count.appendChild(this.el("span", "skollov-unit medium", t.unit));
		hero.appendChild(count);

		if (t.progress !== null) {
			const bar = this.el("div", "skollov-progress");
			const fill = this.el("div", "skollov-progress-fill");
			fill.style.width = `${Math.round(t.progress * 100)}%`;
			bar.appendChild(fill);
			hero.appendChild(bar);
		}

		hero.appendChild(this.el("div", "skollov-line small normal", t.line));
		return hero;
	},

	renderNone() {
		const box = this.el("div", "skollov-hero skollov-hero--none");
		box.appendChild(this.el("div", "skollov-emoji", "📅"));
		box.appendChild(this.el("div", "skollov-line small bright", "Inga fler lov i kalendern just nu"));
		box.appendChild(
			this.el(
				"div",
				"skollov-sub xsmall dimmed",
				"Lovdatum för nästa läsår är inte publicerade på skollov.nu än. De dyker upp här av sig själva när de finns."
			)
		);
		return box;
	},

	renderUpcoming(list, today) {
		const table = this.el("table", "skollov-upcoming xsmall dimmed");
		for (const h of list) {
			const row = this.el("tr", `skollov-type-${h.type}`);
			row.appendChild(this.el("td", "skollov-up-emoji", h.emoji));
			row.appendChild(this.el("td", "skollov-up-name", h.name));
			if (this.config.showDates) row.appendChild(this.el("td", "skollov-up-dates", SkollovCore.formatRange(h)));
			row.appendChild(this.el("td", "skollov-up-until", SkollovCore.phraseUntil(h, today)));
			table.appendChild(row);
		}
		return table;
	},

	/** Visible note when skollov.nu has been unreachable for a while and we run on cache. */
	cacheNote(p) {
		if (!p.error || !p.fetchedAt) return null;
		const ageDays = (Date.now() - p.fetchedAt) / (24 * 60 * 60 * 1000);
		if (ageDays < this.config.cacheWarningDays) return null;
		const date = SkollovCore.formatShort(SkollovCore.localDateString(new Date(p.fetchedAt)));
		return `⚠️ Når inte skollov.nu – visar sparade datum från ${date}.`;
	}
});
