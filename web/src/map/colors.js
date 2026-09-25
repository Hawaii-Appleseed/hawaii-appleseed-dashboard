let COLOR_SCHEMES = null;
let VARIABLES = null;
let DEFAULT_THRESHOLDS = [5, 10, 15, 20, 25, 30, 35, 40, 45];

export function initColors(theme, variablesConfig) {
  COLOR_SCHEMES = {};
  for (const [key, def] of Object.entries(theme.color_schemes || {})) {
    COLOR_SCHEMES[key] = def.colors;
  }
  VARIABLES = variablesConfig.variables;
}

export function getSchemeColors(scheme) {
  return (COLOR_SCHEMES && COLOR_SCHEMES[scheme]) || COLOR_SCHEMES?.blue || [];
}

// A variable's class boundaries on the map at `level`: its own scale for that
// geography if variables.json gives one (color_thresholds_by_level, e.g. SNAP
// dollars for counties, which are ten times a district), else the shared one.
export function getThresholds(varKey, level) {
  const v = VARIABLES?.[varKey];
  return (v && (v.color_thresholds_by_level?.[level] || v.color_thresholds)) || DEFAULT_THRESHOLDS;
}

// Color classes, one per legend row: class i spans [thresholds[i],
// thresholds[i+1]) and is drawn in colors[i]. Class 0 also takes everything
// below thresholds[1], which the legend labels "<thresholds[1]". The map fill,
// the point circles and the legend all go through these two helpers so the
// map can't drift out of step with its legend.
export function classColor(i, colors) {
  return colors[Math.min(i, colors.length - 1)];
}

// MapLibre `step` expression that paints `input` by the classes above.
export function stepColorExpression(input, thresholds, colors) {
  // `step` needs at least one stop; below two thresholds there is one class.
  if (thresholds.length < 2) return classColor(0, colors);
  const expr = ['step', input, classColor(0, colors)];
  for (let i = 1; i < thresholds.length; i++) {
    expr.push(thresholds[i], classColor(i, colors));
  }
  return expr;
}

export function getColorForValue(value, varKey, scheme, level) {
  const colors = getSchemeColors(scheme);
  const thresholds = getThresholds(varKey, level);
  const num = parseFloat(value);
  if (isNaN(num)) return '#cccccc';
  for (let i = thresholds.length - 1; i >= 0; i--) {
    if (num >= thresholds[i]) return colors[Math.min(i, colors.length - 1)];
  }
  return colors[0];
}

export function listSchemes() {
  if (!COLOR_SCHEMES) return [];
  return Object.keys(COLOR_SCHEMES);
}
