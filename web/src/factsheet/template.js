function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

const ICONS = {
  bulb: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M9 14a4 4 0 1 1 6 0c-.6.7-1 1.6-1 2.5V18h-4v-1.5c0-.9-.4-1.8-1-2.5z"/></svg>`,
  dollar: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
  utensils: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 22V11"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Z"/></svg>`,
  bus: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6v6"/><path d="M16 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/></svg>`,
  home: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
  download: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  arrowUp: `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg>`,
  arrowDown: `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="18 13 12 19 6 13"/></svg>`,
};

function comparisonHTML(c) {
  if (!c) return '';
  if (c.direction === 'same') {
    return `<div class="fs-stat-comparison"><span class="fs-stat-desc">${c.descriptor}</span></div>`;
  }
  const arrow = c.direction === 'up' ? ICONS.arrowUp : ICONS.arrowDown;
  return `<div class="fs-stat-comparison">
    <span class="fs-stat-delta fs-stat-delta-${c.direction}">${arrow}<span class="fs-stat-value">${c.value}</span><span class="fs-stat-pct">(${c.pct})</span></span>
    <span class="fs-stat-desc">${c.descriptor}</span>
  </div>`;
}

// "under 2 in 5 households" opens a sentence, so it needs a capital.
function sentenceCase(text) {
  const t = String(text ?? '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function generateFactSheetHTML(geo) {
  return `
    <div class="fact-sheet-container">
      <div class="fs-header">
        <img src="${import.meta.env.BASE_URL}assets/logo.png" class="fs-logo" alt="Hawaii Appleseed" onerror="this.style.display='none'">
        <div class="fs-header-text">
          <div class="fs-kicker">Fact Sheet</div>
          <h1 class="fs-header-title">${esc(geo.name)}</h1>
        </div>
        <button class="fs-print-btn" onclick="window.print()">${ICONS.download}<span>Save PDF</span></button>
      </div>

      <div class="fs-main">
        <div class="fs-did-you-know">
          <div class="fs-did-you-know-icon">${ICONS.bulb}</div>
          <div>
            <h3>Did you know?</h3>
            <p><strong class="fs-dyk-fraction">${esc(sentenceCase(geo.aliceFraction))}</strong><span class="fs-dyk-rate">${esc(geo.aliceRate)}</span><span class="fs-dyk-context">are employed, yet struggling to make ends meet.</span></p>
          </div>
        </div>

        <div class="fs-stats-row">
          <div class="fs-stat-card">
            <span class="fs-stat-number">${esc(geo.population)}</span>
            <div class="fs-stat-label">Total Population</div>
          </div>
          <div class="fs-stat-card">
            <span class="fs-stat-number">${esc(geo.medianIncome)}</span>
            <div class="fs-stat-label">Median Income</div>
            ${comparisonHTML(geo.incomeVsState)}
          </div>
          <div class="fs-stat-card">
            <span class="fs-stat-number">${esc(geo.medianRent)}</span>
            <div class="fs-stat-label">Median Rent</div>
            ${comparisonHTML(geo.rentVsState)}
          </div>
        </div>

        <div class="fs-grid">
          <div class="fs-card">
            <h3><span class="fs-card-icon">${ICONS.dollar}</span>Tax Credits</h3>
            <h4>Child Tax Credit (CTC)</h4>
            <ul>
              <li>Families who get its refundable part receive an average of <span class="fs-hi">${esc(geo.ctcAvg)}</span> per year. That part is claimed on <span class="fs-hi">${esc(geo.ctcRate)}</span> of all tax returns.</li>
            </ul>
            <h4>Federal Earned Income Tax Credit (EITC)</h4>
            <ul>
              <li>Working families who claim it receive an average of <span class="fs-hi">${esc(geo.eitcAvg)}</span> per year. It is claimed on <span class="fs-hi">${esc(geo.eitcRate)}</span> of all tax returns.</li>
            </ul>
            <h4>State Earned Income Tax Credit</h4>
            <ul>
              <li>Hawaii's state EITC, 40% of the federal credit, adds an estimated <span class="fs-hi">${esc(geo.stateEitcAvg)}</span> on average for working families.</li>
            </ul>
          </div>

          <div class="fs-card">
            <h3><span class="fs-card-icon">${ICONS.utensils}</span>Food Security</h3>
            <h4>SNAP</h4>
            <ul>
              <li>About <strong>${esc(geo.snapRate)}</strong> of households participate in SNAP.</li>
              <li>Participating households receive an average of <span class="fs-hi">${esc(geo.avgMonthlyBenefit)}</span> per month—about <span class="fs-hi">${esc(geo.dailyPerHousehold)}</span> a day.</li>
              <li>SNAP brought <span class="fs-hi">${esc(geo.snapTotal)}</span> in benefits to ${esc(geo.name)}.</li>
            </ul>
            <h4>School Meals (CEP)</h4>
            <ul>
              <li><strong>${esc(geo.cepPct)}</strong> of schools (${esc(geo.cepSchools)} of ${esc(geo.totalSchools)}) provide free meals to all students through CEP.</li>
              ${geo.cepSchools === 'N/A' && geo.cepDisplay !== 'N/A' ? `<li>${esc(geo.cepDisplay)}</li>` : ''}
            </ul>
          </div>
        </div>

        <div class="fs-grid fs-grid-second">
          <div class="fs-card">
            <h3><span class="fs-card-icon">${ICONS.bus}</span>Transportation</h3>
            <ul>
              <li>Average travel time to work: <strong>${esc(geo.travelTime)} minutes</strong>.</li>
              <li><strong>${esc(geo.transitPct)}</strong> of workers use public transportation.</li>
              <li>Longer commutes reduce quality of life and increase costs for low-income families.</li>
            </ul>
          </div>

          <div class="fs-card">
            <h3><span class="fs-card-icon">${ICONS.home}</span>Housing</h3>
            <ul>
              <li><strong>${esc(geo.renterRate)} of households</strong> are renters, with a median rent of <span class="fs-hi">${esc(geo.medianRent)}</span> per month.</li>
              <li><strong>${esc(geo.rentBurden)}</strong> of renters (${esc(geo.rentBurdenFraction)}) are cost-burdened, spending more than 30% of income on housing.</li>
              <li><strong>${esc(geo.severeRentBurden)}</strong> of renters (${esc(geo.severeRentBurdenFraction)}) are <em>severely</em> cost-burdened, spending more than 50%.</li>
            </ul>
          </div>
        </div>
      </div>

      <div class="fs-footer">
        <div class="fs-footer-brand">
          <img src="${import.meta.env.BASE_URL}assets/logo.png" alt="" onerror="this.style.display='none'" style="height:28px">
          <span>HAWAIʻI APPLESEED<br><small>CENTER FOR LAW &amp; ECONOMIC JUSTICE</small></span>
        </div>
        <div class="fs-footer-url">www.hiappleseed.org/data-dashboard</div>
      </div>
    </div>`;
}
