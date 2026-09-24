import Plotly from 'plotly.js-dist-min';

// Chart colors and type follow the page's tokens (app.css :root).
function token(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function renderChart(containerId, tableId, features, varKey, varMeta, layerLabel, stateFeatures) {
  const unit = getUnit(varMeta);
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

  const hoverFmt = unit === '$' ? '$%{y:,.0f}' : unit === '%' ? '%{y:.1f}%' : '%{y:.1f}';
  const textFmt = unit === '$' ? '$%{text:,.0f}' : unit === '%' ? '%{text:.1f}%' : '%{text:.1f}';
  const varShort = varMeta?.display_name || varKey;
  const varLong = varMeta?.display_name_long || varShort;
  const chartTitle = unit === '%'
    ? `Percentage of ${varShort} (${layerLabel})`
    : `${varLong} (${layerLabel})`;

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
      tickformat: unit === '$' ? '$,d' : undefined,
    },
    xaxis: {
      title: { text: '' },
      showgrid: false,
      showticklabels: n <= 10,
      tickangle: n <= 10 ? -40 : 0,
      tickfont: { size: 12, color: ink2 },
    },
    // Room under the bars for the slanted names at 12px.
    margin: { l: 55, r: 20, t: 50, b: n <= 10 ? 90 : 28 },
    uniformtext: { minsize: 7, mode: 'hide' },
  };

  const shapes = [];
  const annotations = [];
  if (stateFeatures && stateFeatures.length > 0) {
    const sv = parseFloat(stateFeatures[0].properties[varKey]);
    if (!isNaN(sv)) {
      const lbl = unit === '%' ? `State: ${sv.toFixed(1)}%` : unit === '$' ? `State: $${sv.toLocaleString()}` : `State: ${sv.toFixed(1)}`;
      const ref = token('--chart-ref', '#2b322c');
      shapes.push({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: sv, y1: sv, line: { color: ref, width: 1.5, dash: 'dot' } });
      annotations.push({ xref: 'paper', x: 1, y: sv, text: lbl, showarrow: false, font: { size: 12, color: ref }, xanchor: 'right', yanchor: 'bottom' });
    }
  }
  if (shapes.length) { layout.shapes = shapes; layout.annotations = annotations; }

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
    caption.textContent = `Showing all ${n} ${layerLabel.toLowerCase()} ranked by ${varShort}. Hover for details.`;
    document.getElementById(containerId).after(caption);
  }

  renderTable(tableId, rows, varKey, varMeta);
}

function renderTable(tableId, rows, varKey, varMeta) {
  const unit = getUnit(varMeta);
  const varLabel = varMeta?.display_name_long || varKey;
  const el = document.getElementById(tableId);
  if (!el) return;
  const fmt = (v) => {
    const n = parseFloat(v);
    if (isNaN(n)) return v;
    if (unit === '$') return '$' + Math.round(n).toLocaleString();
    if (unit === '%') return n.toFixed(1) + '%';
    return n.toFixed(1);
  };
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
  const showCols = Object.entries(vars)
    .filter(([, v]) => v.show_in_dropdown)
    .sort(([, a], [, b]) => (a.dropdown_order || 999) - (b.dropdown_order || 999));

  const rows = features
    .map((f) => f.properties)
    .sort((a, b) => {
      const na = cleanName(a), nb = cleanName(b);
      return na.localeCompare(nb);
    });

  const headers = ['Area', ...showCols.map(([, v]) => v.display_name)];
  const tableHtml = `
    <table class="da-full-table">
      <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((p) => {
        const nameCell = `<td>${escapeHtml(cleanName(p))}</td>`;
        const valCells = showCols.map(([k, v]) => {
          const val = p[k];
          return `<td>${escapeHtml(formatCell(val, v.data_type))}</td>`;
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
        ...showCols.map(([k, v]) => formatCell(p[k], v.data_type)),
      ]);
      const stamp = new Date().toISOString().slice(0, 10);
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

function getUnit(meta) {
  const long = meta?.display_name_long || '';
  if (long.includes('($)') || long.includes('($')) return '$';
  if (long.includes('(%)') || meta?.data_type === 'percentage') return '%';
  return '';
}

function cleanName(props) {
  if (typeof props === 'string') return props;
  let name = props.display_name || props.NAME || props.name || '';
  name = name.replace(/[,;]\s*Hawaii/g, '').replace(/\s*\(\d{4}\)\s*/g, '').trim();
  return name || 'Unknown';
}

function formatCell(value, dataType) {
  if (value == null || value === '') return '';
  const n = parseFloat(value);
  if (isNaN(n)) return String(value);
  if (dataType === 'percentage' || /rate|pct|percent/.test(dataType || '')) return n.toFixed(1) + '%';
  if (dataType === 'currency' || /income|value|benefit|amount/.test(dataType || '')) return '$' + Math.round(n).toLocaleString();
  if (dataType === 'minutes') return n.toFixed(1) + ' min';
  if (dataType === 'count') return n.toLocaleString();
  return n.toLocaleString();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
