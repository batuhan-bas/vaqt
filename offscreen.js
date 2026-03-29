// Offscreen document — handles geolocation on behalf of the extension.
// This avoids the "Is the 'geolocation' permission appropriate?" warning
// that Chrome shows when popup.html calls navigator.geolocation directly.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'get-location') return;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      sendResponse({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    },
    (err) => {
      sendResponse({ error: err.code });
    },
    { timeout: 10000, maximumAge: 300000 }
  );

  // Return true to indicate we will call sendResponse asynchronously
  return true;
});
