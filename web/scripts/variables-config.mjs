// The dashboard's variables are defined in one file, src/config/variables.json.
// The Python side reads it directly (src/config/variable_registry.py). The web
// app gets it through the Vite plugin below, which serves it in dev and writes
// it into the build as /config/variables.json with every field filled in.
//
// runCheck() validates that file against itself, data_sources.json and the
// built data in web/public/data. `vite build`, `npm run check` and CI all run
// it, so a mistake fails the build instead of shipping a broken map.
//
// Fields an entry may leave out, and what they default to (expandVariable):
//   display_name_long        display_name + " (%)" / " ($)" for percentage / currency
//   dropdown_label           display_name_long
//   show_in_dropdown         true
//   dropdown_group           null (only for variables kept out of the dropdowns)
//   info_panel_category      null (not in the info panel)
//   info_panel_label         display_name, when there is an info_panel_category
//   info_panel_order         null (sorts last)
//   show_in_info_panel       whether there is an info_panel_category
//   fact_sheet_category      null
//   fact_sheet_label         display_name, when there is a fact_sheet_category
//   show_in_fact_sheet       whether there is a fact_sheet_category
//   show_in_default_metrics  show_in_info_panel
//   is_special_variable      false
//   legend_direction         "neutral"
//   csv_column               the variable's key
//   data_source              null (only for render_type "points")
//   description              ""
//   color_thresholds_by_level
//                            {} (a level listed, e.g. {"county": [...]}, uses those
//                            thresholds; the other levels use color_thresholds)
// Always given: display_name, data_type, color_thresholds and source, plus
// dropdown_group and dropdown_order for anything shown in a dropdown.
//
// src/config/variable_registry.py applies the same defaults; keep the two in step.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const VARIABLES_PATH = path.join(ROOT, 'src/config/variables.json');
export const DATA_SOURCES_PATH = path.join(ROOT, 'src/config/data_sources.json');
const THEME_PATH = path.join(ROOT, 'web/public/config/theme.json');
const DATA_DIR = path.join(ROOT, 'web/public/data');
const LEVELS = ['state', 'county', 'house', 'senate'];
const DATA_TYPES = ['percentage', 'currency', 'count', 'decimal', 'minutes', 'text'];
const UNIT_SUFFIX = { percentage: ' (%)', currency: ' ($)' };
const TOP_LEVEL = ['_comment', 'dropdown_groups', 'info_panel_categories', 'fact_sheet_categories', 'default_color_thresholds', 'variables'];
const FIELDS = [
  'display_name', 'display_name_long', 'description', 'data_type', 'data_source', 'source',
  'dropdown_group', 'dropdown_label', 'dropdown_order', 'show_in_dropdown',
  'info_panel_category', 'info_panel_label', 'info_panel_order', 'show_in_info_panel',
  'fact_sheet_category', 'fact_sheet_label', 'show_in_fact_sheet',
  'show_in_default_metrics', 'is_special_variable', 'legend_direction',
  'color_thresholds', 'color_thresholds_by_level', 'csv_column', 'render_type', 'points_data',
];

export function expandVariable(key, entry) {
  const v = { ...entry };
  const fill = (field, value) => { if (!(field in v)) v[field] = value; };
  fill('display_name_long', v.display_name + (UNIT_SUFFIX[v.data_type] ?? ''));
  fill('dropdown_label', v.display_name_long);
  fill('show_in_dropdown', true);
  fill('dropdown_group', null);
  fill('info_panel_category', null);
  fill('info_panel_label', v.info_panel_category === null ? null : v.display_name);
  fill('info_panel_order', null);
  fill('show_in_info_panel', v.info_panel_category !== null);
  fill('fact_sheet_category', null);
  fill('fact_sheet_label', v.fact_sheet_category === null ? null : v.display_name);
  fill('show_in_fact_sheet', v.fact_sheet_category !== null);
  fill('show_in_default_metrics', v.show_in_info_panel);
  fill('is_special_variable', false);
  fill('legend_direction', 'neutral');
  fill('csv_column', key);
  fill('data_source', null);
  fill('description', '');
  fill('color_thresholds_by_level', {});
  return v;
}

export function expandConfig(config) {
  const variables = {};
  for (const [key, entry] of Object.entries(config.variables)) variables[key] = expandVariable(key, entry);
  const { _comment, ...rest } = config;
  return { ...rest, variables };
}

// JSON.parse keeps the last of two identical keys without a word, which would
// silently drop a variable pasted in under an existing name.
function duplicateKeys(text) {
  const dupes = [];
  const stack = []; // one Set of keys per open object, null per open array
  let expectKey = false;
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]:,]/g)) {
    if (token === '{') { stack.push(new Set()); expectKey = true; }
    else if (token === '[') { stack.push(null); expectKey = false; }
    else if (token === '}' || token === ']') { stack.pop(); expectKey = false; }
    else if (token === ',') expectKey = stack.at(-1) instanceof Set;
    else if (token === ':') expectKey = false;
    else if (expectKey) {
      const keys = stack.at(-1);
      const key = JSON.parse(token);
      if (keys.has(key)) dupes.push(key);
      keys.add(key);
      expectKey = false;
    }
  }
  return dupes;
}

// The known field within two edits of a misspelled one, if any.
function closestField(name) {
  const distance = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = row[j];
        row[j] = next;
      }
    }
    return row[b.length];
  };
  const [best] = FIELDS.map((f) => [f, distance(name, f)]).sort((x, y) => x[1] - y[1]);
  return best[1] <= 2 ? best[0] : null;
}

const yearIn = (text) => String(text ?? '').match(/\b(19|20)\d{2}\b/)?.[0] ?? null;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const listOf = (values) => values.map((x) => JSON.stringify(x)).join(', ');

// Checks a parsed variables.json. `dataSources` is data_sources.json's
// `sources`, `paletteSize` the shortest color scheme in theme.json, `levels`
// maps each geography level to its GeoJSON features, and `loadPoints(file)`
// returns a points layer's FeatureCollection (or null if the file is missing).
export function checkConfig(config, { dataSources, paletteSize, levels, loadPoints }) {
  const errors = [];
  const warnings = [];

  for (const key of Object.keys(config)) {
    if (!TOP_LEVEL.includes(key)) errors.push(`unknown top-level key "${key}"`);
  }
  const groups = config.dropdown_groups ?? {};
  const infoCategories = config.info_panel_categories ?? {};
  const factCategories = config.fact_sheet_categories ?? {};
  const entries = Object.entries(config.variables ?? {});
  if (!entries.length) errors.push('no variables defined');

  const dropdownOrders = new Map(); // "group|order" -> first key seen
  for (const [key, entry] of entries) {
    const err = (msg) => errors.push(`${key}: ${msg}`);
    const warn = (msg) => warnings.push(`${key}: ${msg}`);
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { err('must be an object'); continue; }
    for (const field of Object.keys(entry)) {
      if (FIELDS.includes(field)) continue;
      const guess = closestField(field);
      err(`unknown field "${field}"${guess ? ` (did you mean "${guess}"?)` : ` (known fields: ${FIELDS.join(', ')})`}`);
    }
    const v = expandVariable(key, entry);
    const points = v.render_type === 'points';
    const displayed = v.show_in_dropdown || v.show_in_info_panel;

    if (typeof v.display_name !== 'string' || !v.display_name.trim()) err('needs a display_name');
    if (!DATA_TYPES.includes(v.data_type)) err(`data_type must be one of ${listOf(DATA_TYPES)}, not ${JSON.stringify(v.data_type)}`);
    if (v.dropdown_group !== null && !(v.dropdown_group in groups)) {
      err(`dropdown_group ${JSON.stringify(v.dropdown_group)} isn't in dropdown_groups (${listOf(Object.keys(groups))})`);
    }
    if (v.show_in_dropdown && v.dropdown_group === null) err('is shown in a dropdown, so it needs a dropdown_group');
    if (v.info_panel_category !== null && !(v.info_panel_category in infoCategories)) {
      err(`info_panel_category ${JSON.stringify(v.info_panel_category)} isn't in info_panel_categories`);
    }
    if (v.show_in_info_panel && v.info_panel_category === null) err('show_in_info_panel is true but there is no info_panel_category');
    if (v.fact_sheet_category !== null && !(v.fact_sheet_category in factCategories)) {
      err(`fact_sheet_category ${JSON.stringify(v.fact_sheet_category)} isn't in fact_sheet_categories`);
    }
    if (v.render_type !== undefined && !points) err(`render_type must be "points" or left out, not ${JSON.stringify(v.render_type)}`);
    if (typeof v.source !== 'string' || !v.source.trim()) err('needs a source (the data-year tooltips read it)');
    if (displayed && !String(v.description).trim()) warn('has no description, so its tooltip will be empty');

    const checkThresholds = (t, name) => {
      if (!Array.isArray(t) || !t.length || !t.every(isNum)) {
        err(`${name} must be a non-empty list of numbers`);
      } else {
        if (t.some((x, i) => i > 0 && x <= t[i - 1])) err(`${name} must rise strictly: ${JSON.stringify(t)}`);
        if (t.length > paletteSize) err(`has ${t.length} ${name} but the color schemes only have ${paletteSize} colors`);
      }
    };
    checkThresholds(v.color_thresholds, 'color_thresholds');
    const byLevel = v.color_thresholds_by_level;
    if (byLevel === null || typeof byLevel !== 'object' || Array.isArray(byLevel)) {
      err('color_thresholds_by_level must be an object from level to thresholds, e.g. {"county": [...]}');
    } else {
      for (const [level, t] of Object.entries(byLevel)) {
        if (!LEVELS.includes(level)) err(`color_thresholds_by_level has "${level}", which isn't a level (${listOf(LEVELS)})`);
        else checkThresholds(t, `color_thresholds_by_level.${level}`);
      }
    }

    if (v.data_source === null) {
      if (!points) err('needs a data_source (a key in data_sources.json)');
    } else if (!(v.data_source in dataSources)) {
      err(`data_source ${JSON.stringify(v.data_source)} isn't in data_sources.json (${listOf(Object.keys(dataSources))})`);
    } else {
      const sourceYear = yearIn(v.source);
      const dataYear = dataSources[v.data_source].year;
      if (dataYear && sourceYear && String(dataYear) !== sourceYear) {
        warn(`source says ${sourceYear} (the year the app shows) but data_sources.json has ${v.data_source} at ${dataYear}`);
      }
    }

    if (v.show_in_dropdown) {
      if (!isNum(v.dropdown_order)) {
        err('is shown in a dropdown, so it needs a numeric dropdown_order');
      } else {
        const slot = `${v.dropdown_group}|${v.dropdown_order}`;
        const other = dropdownOrders.get(slot);
        if (other) err(`dropdown_order ${v.dropdown_order} is already used by ${other} in ${v.dropdown_group}`);
        else dropdownOrders.set(slot, key);
      }
    }

    if (points) {
      if (!v.points_data) { err('render_type "points" needs a points_data file'); continue; }
      const fc = loadPoints(v.points_data);
      if (!fc) { err(`points_data file web/public/data/${v.points_data} doesn't exist`); continue; }
      const feats = Array.isArray(fc.features) ? fc.features : [];
      if (!feats.length) err(`points_data ${v.points_data} has no features`);
      const bad = feats.filter((f) => f?.geometry?.type !== 'Point' || !isNum(f?.properties?.[v.csv_column]));
      if (bad.length) err(`${bad.length} of ${feats.length} features in ${v.points_data} aren't points with a numeric "${v.csv_column}"`);
      continue;
    }

    // Choropleths color by the property named after the key, so a different
    // csv_column would be ignored and the map drawn all gray.
    if (v.csv_column !== key) err(`csv_column must equal the key ("${key}"); the map reads the property of that name`);
    if (!displayed) continue;
    for (const [level, features] of Object.entries(levels)) {
      const missing = features.filter((f) => !(key in (f.properties ?? {}))).length;
      const empty = features.filter((f) => [null, ''].includes(f.properties?.[key] ?? null)).length;
      if (missing === features.length) err(`no "${key}" property in ${level}.geojson — the map would be all gray`);
      else if (missing) err(`"${key}" is missing from ${missing} of ${features.length} features in ${level}.geojson`);
      else if (empty === features.length) err(`"${key}" is empty in every feature of ${level}.geojson`);
      else if (empty) warn(`"${key}" is empty in ${empty} of ${features.length} features of ${level}.geojson (drawn as no data)`);
    }
  }
  return { errors, warnings };
}

// Loads every input from disk and checks it. Returns { config, errors,
// warnings }; config is the expanded copy for the web app, or null if the
// file couldn't be read or parsed.
export function runCheck() {
  let text;
  let config;
  try {
    text = readFileSync(VARIABLES_PATH, 'utf8');
    config = JSON.parse(text);
  } catch (e) {
    return { config: null, errors: [`can't read src/config/variables.json: ${e.message}`], warnings: [] };
  }
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const dataSources = readJson(DATA_SOURCES_PATH).sources ?? {};
  const schemes = Object.values(readJson(THEME_PATH).color_schemes ?? {});
  const paletteSize = Math.min(...schemes.map((s) => s.colors?.length ?? 0));
  const levels = {};
  for (const level of LEVELS) levels[level] = readJson(path.join(DATA_DIR, `${level}.geojson`)).features ?? [];
  const loadPoints = (file) => {
    const p = path.join(DATA_DIR, file);
    return existsSync(p) ? readJson(p) : null;
  };
  const errors = duplicateKeys(text).map((k) => `duplicate key "${k}" (JSON keeps only the last one)`);
  const result = checkConfig(config, { dataSources, paletteSize, levels, loadPoints });
  errors.push(...result.errors);
  return { config: expandConfig(config), errors, warnings: result.warnings };
}

export function formatReport({ errors, warnings }) {
  const lines = [];
  if (errors.length) lines.push(`src/config/variables.json has ${errors.length} error(s):`, ...errors.map((e) => `  ✗ ${e}`));
  if (warnings.length) lines.push(`${warnings.length} warning(s):`, ...warnings.map((w) => `  ! ${w}`));
  return lines.join('\n');
}

// Vite plugin. Dev: serves the expanded copy at /config/variables.json,
// reports problems in the terminal and reloads the page when the file
// changes. Build: fails on errors and writes config/variables.json.
export function variablesConfig() {
  let expanded = null;
  return [
    {
      name: 'variables-config:build',
      apply: 'build',
      buildStart() {
        const result = runCheck();
        for (const w of result.warnings) this.warn(`variables.json: ${w}`);
        if (result.errors.length) this.error(formatReport({ errors: result.errors, warnings: [] }));
        expanded = result.config;
      },
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'config/variables.json', source: JSON.stringify(expanded) });
      },
    },
    {
      name: 'variables-config:serve',
      apply: 'serve',
      configureServer(server) {
        const { logger } = server.config;
        let current;
        const refresh = () => {
          current = runCheck();
          const report = formatReport(current);
          if (current.errors.length) logger.error(report, { timestamp: true });
          else if (report) logger.warn(report, { timestamp: true });
        };
        refresh();
        server.watcher.add([VARIABLES_PATH, DATA_SOURCES_PATH]);
        server.watcher.on('change', (file) => {
          if (file !== VARIABLES_PATH && file !== DATA_SOURCES_PATH) return;
          refresh();
          server.ws.send({ type: 'full-reload' });
        });
        server.middlewares.use((req, res, next) => {
          if (req.url?.split('?')[0] !== '/config/variables.json') return next();
          if (!current.config) {
            res.statusCode = 500;
            res.end(formatReport(current));
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(current.config));
        });
      },
    },
  ];
}
