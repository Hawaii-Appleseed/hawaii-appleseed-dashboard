const cache = new Map();

// BASE_URL is '/' in dev, '/hawaii-appleseed-dashboard/' in production GH Pages build
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

export async function fetchJson(path) {
  const url = BASE + path;
  if (cache.has(url)) return cache.get(url);
  const promise = fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
    return r.json();
  });
  cache.set(url, promise);
  // Forget a failure, so the next request tries the network again.
  promise.catch(() => cache.delete(url));
  return promise;
}

export function loadConfig() {
  return Promise.all([
    fetchJson('/config/variables.json'),
    fetchJson('/config/theme.json'),
    fetchJson('/config/ui_strings.json'),
  ]).then(([variables, theme, uiStrings]) => ({ variables, theme, uiStrings }));
}

export function loadLayer(level) {
  return fetchJson(`/data/${level}.geojson`);
}

export function loadStateSummary() {
  return fetchJson('/data/state_summary.json');
}

export function loadRepData() {
  return fetchJson('/data/rep_data.json').catch(() => ({}));
}
