// Bridge between a report page and the extension. The page cannot call
// Checkmarx One itself (it is opened as a file), so it posts requests here.
(() => {
  const CHANNEL = 'cx-report-connector';
  document.documentElement.setAttribute('data-cx-report-connector', chrome.runtime.getManifest().version);

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || data?.channel !== CHANNEL || data.kind !== 'request') return;
    chrome.runtime.sendMessage(data.request, (response) => {
      const error = chrome.runtime.lastError;
      window.postMessage(
        { channel: CHANNEL, kind: 'response', id: data.id, response: error ? { error: error.message } : response },
        '*',
      );
    });
  });
})();
