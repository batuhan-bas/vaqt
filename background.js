// Background service worker for Vaqt
// Handles alarms, notifications, and offscreen geolocation

importScripts('shared.js');

/* ───────── Alarms ───────── */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'refresh-times') {
    await schedulePrayerAlarms();
    return;
  }

  // Prayer time alarm — show notification if enabled
  if (alarm.name.startsWith('prayer-')) {
    const result = await chrome.storage.local.get('settings');
    const settings = result.settings || {};
    if (settings.notifications === false) return;

    const prayerKey = alarm.name.replace('prayer-', '');
    const label = PRAYER_LABELS[prayerKey] || prayerKey;

    chrome.notifications.create(alarm.name, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Vaqt',
      message: `${label} — It's time for prayer`,
      priority: 2,
      silent: settings.sound === false,
    });
  }
});

// Chrome may clear alarms when the browser restarts, so recreate the hourly
// refresh on startup too. Without it, notifications stop the next day.
async function ensureRefreshAlarm() {
  const existing = await chrome.alarms.get('refresh-times');
  if (!existing) {
    await chrome.alarms.create('refresh-times', { periodInMinutes: 60 });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureRefreshAlarm();
  schedulePrayerAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureRefreshAlarm();
  schedulePrayerAlarms();
});

/* ───────── Schedule Prayer Alarms ───────── */
async function schedulePrayerAlarms() {
  let result;
  try {
    result = await chrome.storage.local.get('settings');
  } catch {
    return;
  }

  const settings = result.settings;
  if (!settings || !settings.lat || !settings.lng) return;

  let data;
  try {
    const res = await fetch(timingsUrl(settings.lat, settings.lng, settings.method || 13));
    const json = await res.json();
    if (!json || json.code !== 200 || !json.data || !json.data.timings) return;
    data = json.data;
  } catch {
    return;
  }

  const now = Date.now();

  // Clear old prayer alarms
  for (const key of PRAYER_KEYS) {
    await chrome.alarms.clear(`prayer-${key}`);
  }

  // Schedule alarms for remaining prayers today
  for (const key of PRAYER_KEYS) {
    if (key === 'Sunrise') continue; // No notification for sunrise

    const when = prayerEpoch(data, key);
    if (when > now) {
      chrome.alarms.create(`prayer-${key}`, { when });
    }
  }
}

// Re-schedule when settings change (e.g. user changes location or method)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) {
    schedulePrayerAlarms();
  }
});

/* ───────── Offscreen Geolocation ───────── */
const OFFSCREEN_PATH = 'offscreen.html';

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });

  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['GEOLOCATION'],
    justification: 'Accessing geolocation to calculate prayer times',
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'request-location') return;

  (async () => {
    try {
      await ensureOffscreenDocument();
      const response = await chrome.runtime.sendMessage({ type: 'get-location' });
      sendResponse(response);
    } catch (err) {
      sendResponse({ error: -1, message: err.message });
    }
  })();

  return true;
});
