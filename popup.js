/* ───────── Constants ───────── */
// PRAYER_KEYS, PRAYER_LABELS and the time helpers live in shared.js.
const GEOCODE_BASE = 'https://nominatim.openstreetmap.org';

/* ───────── State ───────── */
let prayerTimes = {};
let countdownInterval = null;

/* ───────── DOM Refs ───────── */
const $loading = document.getElementById('loading');
const $permission = document.getElementById('permission');
const $main = document.getElementById('main');
const $settings = document.getElementById('settings');
const $error = document.getElementById('error');
const $errorMessage = document.getElementById('error-message');
const $retryBtn = document.getElementById('retry-btn');
const $grantBtn = document.getElementById('grant-btn');
const $settingsBtn = document.getElementById('settings-btn');
const $backBtn = document.getElementById('back-btn');
const $cityName = document.getElementById('city-name');
const $hijriDate = document.getElementById('hijri-date');
const $gregorianDate = document.getElementById('gregorian-date');
const $countdown = document.getElementById('countdown');
const $countdownBar = document.getElementById('countdown-bar');
const $nextPrayerName = document.getElementById('next-prayer-name');
const $calcMethod = document.getElementById('calc-method');
const $citySearch = document.getElementById('city-search');
const $cityResults = document.getElementById('city-results');
const $settingsCityInput = document.getElementById('settings-city-input');
const $settingsCityResults = document.getElementById('settings-city-results');
const $settingsCitySearch = document.getElementById('settings-city-search');
const $changeLocationBtn = document.getElementById('change-location-btn');
const $currentLocation = document.getElementById('current-location');
const $useLocationBtn = document.getElementById('use-location-btn');

/* ───────── Settings Helpers ───────── */
async function loadSettings() {
  // locationSource: 'gps' follows the device, 'manual' keeps the city the user picked.
  const defaults = { method: 13, timeFormat: '24h', notifications: true, sound: true, lat: null, lng: null, city: null, locationSource: 'gps' };
  try {
    const result = await chrome.storage.local.get('settings');
    return { ...defaults, ...(result.settings || {}) };
  } catch {
    return defaults;
  }
}

async function saveSettings(patch) {
  const current = await loadSettings();
  const updated = { ...current, ...patch };
  await chrome.storage.local.set({ settings: updated });
  return updated;
}

/* ───────── Location ───────── */
async function getLocation() {
  const response = await chrome.runtime.sendMessage({ type: 'request-location' });

  if (response && response.lat !== undefined && response.lng !== undefined) {
    return { lat: response.lat, lng: response.lng };
  }

  const errorCode = response && response.error;
  const messages = {
    1: 'Location permission denied. Please allow access in your browser settings.',
    2: 'Unable to determine location. Please check your internet connection.',
    3: 'Location request timed out.',
  };
  throw new Error(messages[errorCode] || 'Unable to get location.');
}

async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(
      `${GEOCODE_BASE}/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&format=json&accept-language=en`
    );
    if (!res.ok) return 'Unknown Location';
    const data = await res.json();
    const addr = data.address || {};
    return addr.city || addr.town || addr.county || addr.state || 'Unknown Location';
  } catch {
    return 'Unknown Location';
  }
}

/* ───────── City Search ───────── */
// The public Nominatim server allows at most 1 request per second and no
// search-as-you-type, so we search only when the user presses Enter.
const SEARCH_MIN_INTERVAL_MS = 1000;
let lastSearchAt = 0;

async function searchCities(query) {
  if (query.length < 2) return [];
  const wait = lastSearchAt + SEARCH_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastSearchAt = Date.now();
  try {
    const res = await fetch(
      `${GEOCODE_BASE}/search?q=${encodeURIComponent(query)}&format=json&limit=5&accept-language=en`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.map((item) => ({
      name: item.display_name.split(',')[0].trim(),
      detail: item.display_name.split(',').slice(1, 3).join(',').trim(),
      lat: parseFloat(item.lat),
      lng: parseFloat(item.lon),
    }));
  } catch {
    return [];
  }
}

function showSearchMessage(container, text) {
  const msg = document.createElement('div');
  msg.className = 'city-searching';
  msg.textContent = text;
  container.replaceChildren(msg);
}

// Place names come from a third-party API, so they are set with textContent,
// never innerHTML.
function renderCityResults(container, cities, onPick) {
  const items = cities.map((city) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'city-result-item';

    const name = document.createElement('div');
    name.className = 'city-result-name';
    name.textContent = city.name;

    const detail = document.createElement('div');
    detail.className = 'city-result-detail';
    detail.textContent = city.detail;

    btn.append(name, detail);
    btn.addEventListener('click', () => onPick(city));
    return btn;
  });

  const credit = document.createElement('a');
  credit.className = 'city-credit';
  credit.href = 'https://www.openstreetmap.org/copyright';
  credit.target = '_blank';
  credit.rel = 'noopener';
  credit.textContent = '© OpenStreetMap contributors';

  container.replaceChildren(...items, credit);
}

function setupCitySearch(input, resultsContainer, onSelect) {
  input.addEventListener('input', () => {
    if (input.value.trim().length < 2) resultsContainer.classList.add('hidden');
  });

  input.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const query = input.value.trim();
    if (query.length < 2) return;

    showSearchMessage(resultsContainer, 'Searching...');
    resultsContainer.classList.remove('hidden');

    const cities = await searchCities(query);
    if (cities.length === 0) {
      showSearchMessage(resultsContainer, 'No results found');
      return;
    }
    renderCityResults(resultsContainer, cities, (city) => {
      onSelect(city);
      input.value = '';
      resultsContainer.classList.add('hidden');
    });
  });
}

async function selectCity(city) {
  showScreen($loading);
  try {
    await saveSettings({ lat: city.lat, lng: city.lng, city: city.name, locationSource: 'manual' });
    $cityName.textContent = city.name;
    $currentLocation.textContent = city.name;
    const settings = await loadSettings();
    await loadPrayerData(settings);
    showScreen($main);
  } catch (err) {
    showError(err.message);
  }
}

/* ───────── API ───────── */
async function fetchPrayerTimes(lat, lng, method) {
  let res;
  try {
    res = await fetch(timingsUrl(lat, lng, method));
  } catch {
    throw new Error('Could not fetch prayer times. Please check your internet connection.');
  }

  if (!res.ok) {
    throw new Error(`API error (${res.status}). Please try again.`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Could not read API response. Please try again.');
  }

  if (!data || data.code !== 200 || !data.data || !data.data.timings) {
    throw new Error('Invalid API response. Please try again.');
  }

  // Validate that all required prayer times exist
  for (const key of PRAYER_KEYS) {
    if (!data.data.timings[key]) {
      throw new Error(`Could not retrieve ${PRAYER_LABELS[key]} time.`);
    }
  }

  return data.data;
}

/* ───────── Render ───────── */
function showScreen(screen) {
  [$loading, $permission, $main, $settings, $error].forEach((s) => s.classList.add('hidden'));
  screen.classList.remove('hidden');
}

function showError(message) {
  $errorMessage.textContent = message;
  showScreen($error);
}

function formatTime(timeStr, format) {
  const clean = cleanTime(timeStr);
  if (format === '24h') return clean;

  const [h, m] = clean.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// Times are shown as the location's wall clock; comparisons use absolute
// times from prayerEpoch so a city in another time zone still counts down right.
function renderPrayerTimes(data, format) {
  const timings = data.timings;
  const now = Date.now();
  let nextPrayer = null;
  let activePrayer = null;

  for (let i = 0; i < PRAYER_KEYS.length; i++) {
    const key = PRAYER_KEYS[i];
    if (prayerEpoch(data, key) > now) {
      nextPrayer = key;
      activePrayer = i > 0 ? PRAYER_KEYS[i - 1] : null;
      break;
    }
  }

  if (!nextPrayer) {
    activePrayer = PRAYER_KEYS[PRAYER_KEYS.length - 1];
  }

  PRAYER_KEYS.forEach((key) => {
    const el = document.querySelector(`[data-prayer="${key}"]`);
    const timeEl = document.getElementById(`time-${key.toLowerCase()}`);
    if (!el || !timeEl) return;

    timeEl.textContent = formatTime(timings[key], format);

    el.classList.remove('active', 'next', 'passed');
    if (key === activePrayer) {
      el.classList.add('active');
    } else if (key === nextPrayer) {
      el.classList.add('next');
    } else if (prayerEpoch(data, key) < now) {
      el.classList.add('passed');
    }
  });

  return nextPrayer;
}

function renderDates(dateData) {
  if (!dateData) return;

  const hijri = dateData.hijri;
  const greg = dateData.gregorian;

  if (hijri) {
    $hijriDate.textContent = `${hijri.day} ${hijri.month.en} ${hijri.year}`;
  }

  // Built from the API's own date parts. Parsing a "YYYY-M-D" string with
  // new Date() can land on the previous day in time zones behind UTC.
  if (greg) {
    $gregorianDate.textContent = `${greg.month.en} ${Number(greg.day)}, ${greg.year}`;
  }
}

/* ───────── Countdown ───────── */
function startCountdown(data, nextKey) {
  if (countdownInterval) clearInterval(countdownInterval);

  function tick() {
    const now = Date.now();
    let target;

    if (nextKey) {
      target = prayerEpoch(data, nextKey);
      $nextPrayerName.textContent = PRAYER_LABELS[nextKey];
    } else {
      // After Isha: tomorrow's Fajr, approximated by today's Fajr + 24h.
      target = prayerEpoch(data, 'Fajr') + DAY_MS;
      $nextPrayerName.textContent = PRAYER_LABELS.Fajr;
    }

    const diff = target - now;
    if (diff <= 0) {
      init();
      return;
    }

    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    const secs = Math.floor((diff % 60000) / 1000);

    $countdown.textContent =
      `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    const prevKey = nextKey
      ? PRAYER_KEYS[PRAYER_KEYS.indexOf(nextKey) - 1]
      : PRAYER_KEYS[PRAYER_KEYS.length - 1];

    // Before Fajr the previous prayer is yesterday's Isha.
    const prevTime = prevKey
      ? prayerEpoch(data, prevKey)
      : prayerEpoch(data, 'Isha') - DAY_MS;

    const total = target - prevTime;
    const elapsed = now - prevTime;
    const progress = Math.max(0, Math.min(100, (elapsed / total) * 100));
    $countdownBar.style.width = `${progress}%`;
  }

  tick();
  countdownInterval = setInterval(tick, 1000);
}

/* ───────── Settings UI ───────── */
$settingsBtn.addEventListener('click', () => showScreen($settings));
$backBtn.addEventListener('click', () => showScreen($main));

$calcMethod.addEventListener('change', async () => {
  const settings = await saveSettings({ method: parseInt($calcMethod.value) });
  if (settings.lat && settings.lng) {
    try {
      await loadPrayerData(settings);
    } catch (err) {
      showError(err.message);
    }
  }
});

document.querySelectorAll('[data-format]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('[data-format]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const settings = await saveSettings({ timeFormat: btn.dataset.format });
    if (prayerTimes.timings) {
      renderPrayerTimes(prayerTimes, settings.timeFormat);
    }
  });
});

document.querySelectorAll('[data-notif]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('[data-notif]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    await saveSettings({ notifications: btn.dataset.notif === 'on' });
  });
});

document.querySelectorAll('[data-sound]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('[data-sound]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    await saveSettings({ sound: btn.dataset.sound === 'on' });
  });
});

/* ───────── City Search Setup ───────── */
setupCitySearch($citySearch, $cityResults, selectCity);
setupCitySearch($settingsCityInput, $settingsCityResults, async (city) => {
  await selectCity(city);
  $settingsCitySearch.classList.add('hidden');
  showScreen($settings);
});

$changeLocationBtn.addEventListener('click', () => {
  $settingsCitySearch.classList.toggle('hidden');
  if (!$settingsCitySearch.classList.contains('hidden')) {
    $settingsCityInput.focus();
  }
});

/* ───────── Main Flow ───────── */
async function loadPrayerData(settings) {
  const data = await fetchPrayerTimes(settings.lat, settings.lng, settings.method);
  prayerTimes = data;
  const nextKey = renderPrayerTimes(data, settings.timeFormat);
  renderDates(data.date);
  startCountdown(data, nextKey);
}

async function useDeviceLocation() {
  const loc = await getLocation();
  const city = await reverseGeocode(loc.lat, loc.lng);
  await saveSettings({ lat: loc.lat, lng: loc.lng, city, locationSource: 'gps' });
  $cityName.textContent = city;
  $currentLocation.textContent = city;
}

async function init() {
  showScreen($loading);

  const settings = await loadSettings();

  $calcMethod.value = settings.method;
  document.querySelectorAll('[data-format]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.format === settings.timeFormat);
  });
  document.querySelectorAll('[data-notif]').forEach((btn) => {
    const isOn = settings.notifications !== false;
    btn.classList.toggle('active', btn.dataset.notif === (isOn ? 'on' : 'off'));
  });
  document.querySelectorAll('[data-sound]').forEach((btn) => {
    const isOn = settings.sound !== false;
    btn.classList.toggle('active', btn.dataset.sound === (isOn ? 'on' : 'off'));
  });

  // If we already have a saved location, use it directly
  if (settings.lat && settings.lng) {
    try {
      $cityName.textContent = settings.city || 'Location';
      $currentLocation.textContent = settings.city || 'Location';
      await loadPrayerData(settings);
      showScreen($main);
      // Follow the device only if the user hasn't picked a city by hand.
      if (settings.locationSource !== 'manual') {
        useDeviceLocation().catch(() => {});
      }
      return;
    } catch (apiErr) {
      showError(apiErr.message);
      return;
    }
  }

  // No saved location — try geolocation
  try {
    await useDeviceLocation();
    const updatedSettings = await loadSettings();
    await loadPrayerData(updatedSettings);

    showScreen($main);
  } catch (err) {
    // Geolocation failed and no cache — show permission screen with city search
    showScreen($permission);
  }
}

$grantBtn.addEventListener('click', () => init());

$useLocationBtn.addEventListener('click', async () => {
  showScreen($loading);
  try {
    await useDeviceLocation();
    await loadPrayerData(await loadSettings());
    $settingsCitySearch.classList.add('hidden');
    showScreen($settings);
  } catch (err) {
    showError(err.message);
  }
});
$retryBtn.addEventListener('click', () => init());

// Start
init();
