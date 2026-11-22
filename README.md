# MMM-Skollov

A [MagicMirror²](https://magicmirror.builders/) module that counts down to Swedish school holidays — höstlov 🍂, jullov 🎄, sportlov ⛷️, påsklov 🐣 and sommarlov ☀️ — with a cheerful, Swedish-language display for a family mirror.

- **Before a holiday:** a big countdown in days to the next one ("26 dagar kvar till jullovet!"), getting chattier as it gets close ("på måndag!", "Imorgon är det sportlov!").
- **During a holiday:** the display switches to a warm, glowing "Det är sportlov!" with gently bouncing emoji, the number of holiday days left and a progress bar.
- **No data left:** says so plainly, rather than rendering nothing.

An optional, smaller and dimmer list shows the holidays after the next one.

The lov name is always shown as text; the emoji are decoration, not the only carrier of meaning.

## Data source

Dates come from [skollov.nu](https://skollov.nu), which publishes one iCal file per municipality at `https://skollov.nu/kalender/<kommun>.ics`.

> **Note:** skollov.nu lists the dates for **kommunala grundskolor**. Friskolor often set their own holidays and may differ — check with your school.

The module fetches at most once every 12 hours (default once a day) with an identifying User-Agent. The data only changes once a year.

## Installation

```bash
cd ~/MagicMirror/modules
git clone git@github.com:htilly/MMM-Skollov.git
```

There are no npm dependencies, so there is nothing to `npm install`. Node 18 or later is required (for the built-in `fetch`); any current MagicMirror satisfies that.

Emoji need a colour emoji font. On Raspberry Pi OS:

```bash
sudo apt install fonts-noto-color-emoji
```

## Configuration

Add to `config/config.js`:

```js
{
	module: "MMM-Skollov",
	position: "top_right",
	config: {
		kommun: "huddinge",
		showUpcoming: true,
		maxUpcoming: 3
	}
}
```

| Option | Default | Description |
| --- | --- | --- |
| `kommun` | `"huddinge"` | The municipality. Use the slug from the skollov.nu URL, e.g. `https://skollov.nu/kommun/upplands-vasby/` → `"upplands-vasby"`. Plain names such as `"Upplands Väsby"` or `"Göteborg"` are converted to the slug automatically. |
| `header` | `"Skollov 🎒"` | Header text above the module. Set to `""` to fall back to MagicMirror's own `header` option (or no header). |
| `showUpcoming` | `true` | Show the list of holidays after the main one. |
| `maxUpcoming` | `3` | How many holidays the upcoming list shows. |
| `updateInterval` | `86400000` (24 h) | How often to fetch from skollov.nu, in milliseconds. Values below 12 hours are raised to 12 hours. |
| `staleWarningDays` | `30` | Show a warning on the mirror when the last date in the calendar is this many days away or fewer, i.e. next school year's dates have not been published yet. |
| `summerGreetingDays` | `70` | skollov.nu only publishes the *first* day of sommarlov. The module shows its "Glad sommar!" holiday state for this many days from that date (70 ≈ until mid-August), then switches to the "no data" state if nothing newer has been published. |
| `cacheWarningDays` | `3` | If skollov.nu has been unreachable and the module has been running on cached data for this many days, say so on the mirror. |
| `showDates` | `true` | Show the start date under the countdown and date ranges in the upcoming list. |
| `animate` | `true` | Bouncing emoji during a holiday. Also disabled automatically when the system asks for reduced motion. |
| `calendarUrl` | `null` | Override the iCal URL. Normally left unset; it is built from `kommun`. |
| `debugDate` | `null` | Pretend today is this date (`"YYYY-MM-DD"`). For previewing the states on the mirror, e.g. `"2027-03-03"` to see sportlov. Leave unset in normal use. |

## Staleness and caching

Each skollov.nu file covers one **läsår**. For Huddinge 2026/2027 the last entry is "Sommarlovet börjar" on 10 June 2027; after that the module has nothing to count down to until skollov.nu publishes the next year.

The module handles this on purpose:

- The parsed calendar is cached to `cache/<kommun>.json` in the module directory. If a fetch fails (network, HTTP error, unparseable response, empty calendar) the cached dates keep being shown, so a bad morning at skollov.nu never blanks the mirror.
- When the last date in the data is within `staleWarningDays`, a small orange warning appears under the countdown.
- After the summer greeting window, the module says plainly that there are no more holidays in the calendar yet. The data is refetched on the normal schedule, so the next year shows up by itself once it is published.
- The cache also records when a fetch was last *attempted*, so restarting MagicMirror repeatedly does not cause repeated requests.

## Date handling

All-day iCal events have an **exclusive** end date (RFC 5545): `DTSTART:20270301` / `DTEND:20270306` means 1–5 March, not 1–6. The module subtracts one day from `DTEND`; this is covered by tests against the real Huddinge file. "Lovdagar kvar" counts calendar days including today, so the last day of a holiday reads "Sista lovdagen!".

Dates are handled as plain calendar dates in the mirror's local time zone, so daylight-saving changes cannot shift a holiday.

## Development

```bash
npm test
```

Runs the tests with Node's built-in test runner. `test/fixtures/huddinge-2026-2027.ics` is a verbatim copy of the real feed.

Files:

- `MMM-Skollov.js` — the front-end module (rendering only).
- `node_helper.js` — scheduling; all network and disk access goes through `lib/feed.js`.
- `skollov-core.js` — iCal parsing, date maths, state selection and the Swedish copy. Shared by the browser and Node, no side effects.
- `MMM-Skollov.css` — styles.

The iCal parser is a small hand-written one rather than `node-ical`: the feed is five all-day events, and avoiding a dependency means nothing to `npm install` on the Pi and nothing to keep patched. It handles line folding, CRLF/LF, property parameters and text escapes, which is all these files use.
