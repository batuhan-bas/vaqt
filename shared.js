// Shared by popup.js and background.js (loaded with importScripts there).

const PRAYER_KEYS = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const PRAYER_LABELS = {
  Fajr: 'Fajr',
  Sunrise: 'Sunrise',
  Dhuhr: 'Dhuhr',
  Asr: 'Asr',
  Maghrib: 'Maghrib',
  Isha: 'Isha',
};

const API_BASE = 'https://api.aladhan.com/v1';
const DAY_MS = 24 * 60 * 60 * 1000;

// A Unix timestamp lets the API pick today's date in the location's own time zone.
function timingsUrl(lat, lng, method) {
  const now = Math.floor(Date.now() / 1000);
  return `${API_BASE}/timings/${now}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&method=${encodeURIComponent(method)}`;
}

function cleanTime(timeStr) {
  return timeStr.replace(/\s*\(.*\)/, '');
}

// How far `timeZone` is ahead of UTC at the given instant, in ms.
function timeZoneOffset(timeZone, epoch) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epoch));
  const v = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
  const wallClockAsUtc = Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second);
  return wallClockAsUtc - Math.floor(epoch / 1000) * 1000;
}

// The API returns "HH:MM" in the location's time zone, which may differ from the
// browser's. Convert it to an absolute time so countdowns and alarms are right.
function prayerEpoch(data, key) {
  const [h, m] = cleanTime(data.timings[key]).split(':').map(Number);
  const g = data.date.gregorian;
  const year = Number(g.year);
  const month = Number(g.month.number) - 1;
  const day = Number(g.day);
  const timeZone = data.meta && data.meta.timezone;

  if (!timeZone) return new Date(year, month, day, h, m).getTime();

  const wallClock = Date.UTC(year, month, day, h, m);
  const first = wallClock - timeZoneOffset(timeZone, wallClock);
  // Second pass corrects the offset when a DST change falls between the two instants.
  return wallClock - timeZoneOffset(timeZone, first);
}
