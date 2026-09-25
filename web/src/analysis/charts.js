import Plotly from 'plotly.js-dist-min';

// Chart colors and type follow the page's tokens (app.css :root).
function token(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// Values as the map's tooltips and info panel show them, by data_type.
function formatValue(value, dataType) {
  if (value == null || value === '') return '';
  if (dataType === 'text') return String(value);
  const n = parseFloat(value);
  if (isNaN(n)) return String(value);
  switch (dataType) {
    case 'percentage': return n.toFixed(1) + '%';
    case 'currency': return '$' + Math.round(n).toLocaleString('en-US');
    case 'minutes': return n.toFixed(1) + ' min';
    case 'decimal': return n.toFixed(2);
    default: return n.toLocaleString('en-US');
  }
}

// The same, as a Plotly template for `field` (%{y} or %{text}). A text
// variable charts the number it starts with (CEP schools: "35/55 …" → 35).
function plotlyTemplate(field, dataType) {
  switch (dataType) {
    case 'percentage': return `%{${field}:.1f}%`;
    case 'currency': return `$%{${field}:,.0f}`;
    case 'minutes': return `%{${field}:.1f} min`;
    case 'decimal': return `%{${field}:.2f}`;
    default: return `%{${field}:,.0f}`;
  }
}

// Plotly skips resizing a chart while its tab is hidden; call this when the
// Data tab shows again.
export function resizeChart(containerId) {
  const el = document.getElementById(containerId);
  if (el?.data) Plotly.Plots.resize(el);
}

export function renderChart(containerId, tableId, features, varKey, varMeta, layerLabel, stateFeatures) {
  const dataType = varMeta?.data_type;
  const ink = token('--gray-900', '#161c17');
  const ink2 = token('--gray-600', '#5a625a');
  const grid = token('--gray-100', '#eaece7');
  const font = { family: 'Inter, Arial', size: 12, color: ink };

  // Build sorted data
  const rows = features
    .map((f) => ({ name: cleanName(f.properties), value: f.properties[varKey] }))
    .filter((r) => r.value != null && !isNaN(parseFloat(r.value)))
    .sort((a, b) => parseFloat(b.value) - parseFloat(a.value));

  if (!rows.length) {
    document.getElementById(containerId).innerHTML =
      '<p class="da-notice">No data available for this variable.</p>';
    return;
  }

  const names = rows.map((r) => r.name);
  const values = rows.map((r) => parseFloat(r.value));
  const n = rows.length;

  const hoverFmt = plotlyTemplate('y', dataType);
  const textFmt = plotlyTemplate('text', dataType);
  const varShort = varMeta?.display_name || varKey;
  const varLong = varMeta?.display_name_long || varShort;
  // "Poverty Rate (%) by county" — the long name already carries the unit.
  const perArea = {
    Counties: 'county',
    'House Districts': 'House district',
    'Senate Districts': 'Senate district',
    'State Boundary': 'state',
  }[layerLabel] || layerLabel.toLowerCase();
  let chartTitle = `${varLong} by ${perArea}`;

  // The statewide figure as a dotted line — only where it is a benchmark for
  // one area: a rate or median lies within the areas' range, while a
  // statewide total (SNAP dollars, CEP schools) is far above every area and
  // would squash the bars. Its label goes under the title, clear of the
  // values printed over the bars.
  const shapes = [];
  const sv = parseFloat(stateFeatures?.[0]?.properties[varKey]);
  if (!isNaN(sv) && sv >= Math.min(...values) && sv <= Math.max(...values)) {
    const ref = token('--chart-ref', '#2b322c');
    // Under the bars, so it doesn't strike through the values printed on them.
    shapes.push({ type: 'line', layer: 'below', xref: 'paper', x0: 0, x1: 1, y0: sv, y1: sv, line: { color: ref, width: 1.5, dash: 'dot' } });
    chartTitle += `<br><span style="font-size:12px;color:${ref}">Dotted line: State ${formatValue(sv, dataType)}</span>`;
  }

  const trace = {
    type: 'bar',
    x: names,
    y: values,
    text: values,
    texttemplate: textFmt,
    // Values over the bars only while there's room to read them; with 51
    // districts only a stray few fit, so hover and the side table carry them.
    textposition: n <= 10 ? 'outside' : 'none',
    textfont: { size: 12, color: ink2 },
    cliponaxis: false,
    marker: { color: token('--chart-bar', '#4d8a24') },
    hovertemplate: `<b>%{x}</b><br>${varShort}: ${hoverFmt}<extra></extra>`,
    hoverlabel: { bgcolor: 'white', bordercolor: grid, font: { ...font, size: 12 } },
  };

  const layout = {
    title: { text: chartTitle, x: 0.5, xanchor: 'center', font: { ...font, size: 14 } },
    height: 400,
    showlegend: false,
    plot_bgcolor: 'white',
    paper_bgcolor: 'white',
    font,
    yaxis: {
      gridcolor: grid,
      zeroline: false,
      title: { text: varLong, font: { size: 12, color: ink2 } },
      tickfont: { size: 12, color: ink2 },
      tickformat: dataType === 'currency' ? '$,d' : undefined,
      // Widen the left margin to fit long ticks ($400,000,000).
      automargin: true,
    },
    xaxis: {
      title: { text: '' },
      showgrid: false,
      showticklabels: n <= 10,
      tickangle: n <= 10 ? -40 : 0,
      tickfont: { size: 12, color: ink2 },
    },
    // Room under the bars for the slanted names at 12px, and above them for
    // a second title line.
    margin: { l: 55, r: 20, t: shapes.length ? 70 : 50, b: n <= 10 ? 90 : 28 },
    uniformtext: { minsize: 7, mode: 'hide' },
  };
  if (shapes.length) layout.shapes = shapes;

  const config = {
    displaylogo: false,
    modeBarButtonsToRemove: ['autoScale2d', 'resetScale2d'],
    toImageButtonOptions: { filename: `hawaii_${varKey}` },
    responsive: true,
  };

  Plotly.newPlot(containerId, [trace], layout, config);

  if (n > 10) {
    const caption = document.createElement('p');
    caption.className = 'da-caption';
    caption.textContent = `Showing all ${n} ${layerLabel.replace(/Districts/, 'districts')} ranked by ${varShort}. Hover a bar for its value.`;
    document.getElementById(containerId).after(caption);
  }

  renderTable(tableId, rows, varKey, varMeta);
}

function renderTable(tableId, rows, varKey, varMeta) {
  const varLabel = varMeta?.display_name_long || varKey;
  const el = document.getElementById(tableId);
  if (!el) return;
  const fmt = (v) => formatValue(v, varMeta?.data_type);
  el.innerHTML = `
    <table class="da-table">
      <thead><tr><th>Area</th><th>${escapeHtml(varLabel)}</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(fmt(r.value))}</td></tr>`).join('')}</tbody>
    </table>`;

  // Wire side-table CSV download (button lives in HTML, separate from this container)
  const sideBtn = document.getElementById('da-side-download');
  if (sideBtn) {
    sideBtn.onclick = () => {
      const headers = ['Area', varLabel];
      const csvRows = rows.map((r) => [r.name, fmt(r.value)]);
      downloadCsv(`hawaii_${varKey}_ranked.csv`, headers, csvRows);
    };
    sideBtn.disabled = rows.length === 0;
  }
}

export function renderFullTable(containerId, features, variablesConfig, layerKey) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const vars = variablesConfig?.variables || {};
  const groups = variablesConfig?.dropdown_groups || {};
  const groupOrder = (v) => groups[v.dropdown_group]?.order ?? 999;
  const showCols = Object.entries(vars)
    // Points variables (Millionaires) are counted by town: no column of
    // values per area.
    .filter(([, v]) => v.show_in_dropdown && v.render_type !== 'points')
    // Topic by topic, as in the variable menus (dropdown_order restarts in
    // each group).
    .sort(([, a], [, b]) => groupOrder(a) - groupOrder(b) || (a.dropdown_order || 999) - (b.dropdown_order || 999));

  // Natural order, so District 2 comes before District 10.
  const rows = features
    .map((f) => f.properties)
    .sort((a, b) => cleanName(a).localeCompare(cleanName(b), undefined, { numeric: true }));

  const headers = ['Area', ...showCols.map(([, v]) => v.display_name)];
  const tableHtml = `
    <table class="da-full-table">
      <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((p) => {
        const nameCell = `<td>${escapeHtml(cleanName(p))}</td>`;
        const valCells = showCols.map(([k, v]) => {
          const val = p[k];
          return `<td>${escapeHtml(formatValue(val, v.data_type))}</td>`;
        }).join('');
        return `<tr>${nameCell}${valCells}</tr>`;
      }).join('')}</tbody>
    </table>`;
  el.innerHTML = tableHtml;

  // Wire full-table CSV download (button lives in HTML)
  const fullBtn = document.getElementById('da-full-download');
  if (fullBtn) {
    fullBtn.onclick = () => {
      const csvHeaders = ['Area', ...showCols.map(([, v]) => v.display_name_long || v.display_name)];
      const csvRows = rows.map((p) => [
        cleanName(p),
        ...showCols.map(([k, v]) => formatValue(p[k], v.data_type)),
      ]);
      // Today's date where the reader is (toISOString gives UTC's, which is
      // already tomorrow from 2 pm in Hawaiʻi).
      const d = new Date();
      const pad = (x) => String(x).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const layerSlug = (layerKey || 'data').replace(/\s+/g, '_').toLowerCase();
      downloadCsv(`hawaii_${layerSlug}_${stamp}.csv`, csvHeaders, csvRows);
    };
    fullBtn.disabled = rows.length === 0;
  }
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function downloadCsv(filename, headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  // BOM helps Excel detect UTF-8
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

function cleanName(props) {
  if (typeof props === 'string') return props;
  let name = props.display_name || props.NAME || props.name || '';
  name = name.replace(/[,;]\s*Hawaii/g, '').replace(/\s*\(\d{4}\)\s*/g, '').trim();
  return name || 'Unknown';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
