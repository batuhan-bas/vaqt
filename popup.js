/* ───────── Constants ───────── */
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

/* ───────── Settings Helpers ───────── */
async function loadSettings() {
  const defaults = { method: 13, timeFormat: '24h', notifications: true, sound: true, lat: null, lng: null, city: null };
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
let searchTimeout = null;

async function searchCities(query) {
  if (query.length < 2) return [];
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

function setupCitySearch(input, resultsContainer, onSelect) {
  input.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const query = input.value.trim();
    if (query.length < 2) {
      resultsContainer.classList.add('hidden');
      return;
    }
    resultsContainer.innerHTML = '<div class="city-searching">Searching...</div>';
    resultsContainer.classList.remove('hidden');
    searchTimeout = setTimeout(async () => {
      const cities = await searchCities(query);
      if (cities.length === 0) {
        resultsContainer.innerHTML = '<div class="city-searching">No results found</div>';
        return;
      }
      resultsContainer.innerHTML = cities
        .map(
          (c, i) =>
            `<div class="city-result-item" data-index="${i}">
              <div class="city-result-name">${c.name}</div>
              <div class="city-result-detail">${c.detail}</div>
            </div>`
        )
        .join('');
      resultsContainer.querySelectorAll('.city-result-item').forEach((el) => {
        el.addEventListener('click', () => {
          const city = cities[parseInt(el.dataset.index)];
          onSelect(city);
          input.value = '';
          resultsContainer.classList.add('hidden');
        });
      });
    }, 400);
  });
}

async function selectCity(city) {
  showScreen($loading);
  try {
    await saveSettings({ lat: city.lat, lng: city.lng, city: city.name });
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
  const today = new Date();
  const dd = String(today.getDate()).padStart(2, '0');
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const yyyy = today.getFullYear();

  const url = `${API_BASE}/timings/${dd}-${mm}-${yyyy}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&method=${encodeURIComponent(method)}`;

  let res;
  try {
    res = await fetch(url);
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
  const clean = timeStr.replace(/\s*\(.*\)/, '');
  if (format === '24h') return clean;

  const [h, m] = clean.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function parseTimeToDate(timeStr) {
  const clean = timeStr.replace(/\s*\(.*\)/, '');
  const [h, m] = clean.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

function renderPrayerTimes(timings, format) {
  const now = new Date();
  let nextPrayer = null;
  let activePrayer = null;

  for (let i = 0; i < PRAYER_KEYS.length; i++) {
    const key = PRAYER_KEYS[i];
    const prayerDate = parseTimeToDate(timings[key]);
    if (prayerDate > now) {
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
    } else {
      const prayerDate = parseTimeToDate(timings[key]);
      if (prayerDate < now) {
        el.classList.add('passed');
      }
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

  if (greg) {
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    const d = new Date(`${greg.year}-${greg.month.number}-${greg.day}`);
    $gregorianDate.textContent = `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }
}

/* ───────── Countdown ───────── */
function startCountdown(timings, nextKey) {
  if (countdownInterval) clearInterval(countdownInterval);

  function tick() {
    const now = new Date();
    let target;

    if (nextKey) {
      target = parseTimeToDate(timings[nextKey]);
      $nextPrayerName.textContent = PRAYER_LABELS[nextKey];
    } else {
      target = parseTimeToDate(timings.Fajr);
      target.setDate(target.getDate() + 1);
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

    let prevTime;
    if (prevKey) {
      prevTime = parseTimeToDate(timings[prevKey]);
    } else {
      prevTime = new Date();
      prevTime.setHours(0, 0, 0, 0);
    }

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
      renderPrayerTimes(prayerTimes.timings, settings.timeFormat);
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
  const nextKey = renderPrayerTimes(data.timings, settings.timeFormat);
  renderDates(data.date);
  startCountdown(data.timings, nextKey);
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
      // Refresh location in background
      getLocation().then(async (loc) => {
        const city = await reverseGeocode(loc.lat, loc.lng);
        await saveSettings({ lat: loc.lat, lng: loc.lng, city });
        $cityName.textContent = city;
        $currentLocation.textContent = city;
      }).catch(() => {});
      return;
    } catch (apiErr) {
      showError(apiErr.message);
      return;
    }
  }

  // No saved location — try geolocation
  try {
    const loc = await getLocation();
    const city = await reverseGeocode(loc.lat, loc.lng);
    await saveSettings({ lat: loc.lat, lng: loc.lng, city });

    $cityName.textContent = city;
    $currentLocation.textContent = city;

    const updatedSettings = await loadSettings();
    await loadPrayerData(updatedSettings);

    showScreen($main);
  } catch (err) {
    // Geolocation failed and no cache — show permission screen with city search
    showScreen($permission);
  }
}

$grantBtn.addEventListener('click', () => init());
$retryBtn.addEventListener('click', () => init());

// Start
init();
