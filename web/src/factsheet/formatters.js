export function formatNumber(value, { isPercent = false, isCurrency = false, decimals = 0 } = {}) {
  if (value == null || value === '') return 'N/A';
  try {
    const num = parseFloat(value);
    if (isNaN(num)) return String(value);
    if (isCurrency) return '$' + num.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    if (isPercent) return num.toFixed(1) + '%';
    return num.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  } catch (_) {
    return String(value);
  }
}

// Returns a structured comparison object so the template can style
// the arrow / value / percentage / descriptor independently:
//   { direction: 'up'|'down'|'same', value: '+$5,806', pct: '5.8%',
//     descriptor: 'above state avg' }
// or null when comparison can't be computed.
export function getComparison(currentValue, comparisonValue, comparisonType = 'state', isCurrency = true) {
  if (currentValue == null || comparisonValue == null || comparisonValue === 0) return null;
  try {
    const current = parseFloat(currentValue);
    const comparison = parseFloat(comparisonValue);
    if (isNaN(current) || isNaN(comparison)) return null;
    if (current === comparison) {
      return { direction: 'same', value: '', pct: '', descriptor: `same as ${comparisonType} avg` };
    }
    const direction = current > comparison ? 'up' : 'down';
    const diff = Math.abs(current - comparison);
    const pct = (diff / comparison) * 100;
    const valueStr = isCurrency ? '$' + Math.round(diff).toLocaleString() : Math.round(diff).toLocaleString();
    return {
      direction,
      value: (direction === 'up' ? '+' : '−') + valueStr,
      pct: pct.toFixed(1) + '%',
      descriptor: `${direction === 'up' ? 'above' : 'below'} ${comparisonType} avg`,
    };
  } catch (_) { return null; }
}

export function getFractionText(rate, suffix = 'households') {
  if (!rate || rate <= 0) return '';
  const dec = rate / 100;
  const fractions = [
    [1, 2, 0.5], [1, 3, 0.333], [2, 3, 0.666], [1, 4, 0.25],
    [3, 4, 0.75], [1, 5, 0.2], [2, 5, 0.4], [3, 5, 0.6],
    [4, 5, 0.8], [1, 6, 0.166], [5, 6, 0.833], [1, 7, 0.142],
    [2, 7, 0.285], [3, 7, 0.428], [4, 7, 0.571], [5, 7, 0.714],
    [6, 7, 0.857], [1, 8, 0.125], [1, 9, 0.111],
  ];
  const [num, denom, val] = fractions.reduce((a, b) => Math.abs(dec - b[2]) < Math.abs(dec - a[2]) ? b : a);
  const diff = dec - val;
  let prefix = '';
  if (Math.abs(diff) >= 0.002) {
    if (diff > 0) prefix = diff < 0.01 ? 'just over ' : 'over ';
    else prefix = diff > -0.01 ? 'just under ' : 'under ';
  }
  return `${prefix}${num} in ${denom}${suffix ? ' ' + suffix : ''}`;
}

export function cleanGeoName(raw) {
  if (!raw) return 'Unknown';
  let name = raw;
  if (name.includes(', Hawaii')) {
    const base = name.replace(' County, Hawaii', '').replace(', Hawaii', '');
    const map = { Honolulu: 'Honolulu County', Hawaii: 'Hawaiʻi County', Maui: 'Maui County', Kauai: 'Kauaʻi County' };
    name = map[base] || `${base} County`;
  } else if (/House District|Senate District/.test(name)) {
    if (name.includes(';')) name = name.split(';')[0].trim();
    name = name.replace(/,?\s*Hawaii/, '').replace(/\s*\(\d{4}\)\s*/g, '').trim();
    if (name.startsWith('House District')) name = name.replace('House District', 'State House District');
    if (name.startsWith('Senate District')) name = name.replace('Senate District', 'State Senate District');
  }
  return name;
}

export function buildGeoData(props, stateSummary) {
  const stateEcon = stateSummary?.economic || {};
  const stateHousing = stateSummary?.housing || {};

  const medianIncome = props.median_income;
  const medianRent = props.median_rent;
  const aliceRate = parseFloat(props.alice_rate) || 0;
  const snapRate = props.snap_household_rate;
  const snapTotal = props.snap_benefits_annual_total;
  // Annual benefit dollars per participating SNAP household. The source has no
  // person counts, so the daily figure stays per household, not per person.
  const snapPerHH = props.snap_benefit_annual_per_household;
  const monthlyBenefit = snapPerHH ? parseFloat(snapPerHH) / 12 : 0;
  const dailyPerHousehold = snapPerHH ? parseFloat(snapPerHH) / 365 : 0;
  const rentBurden = props.rent_burden_rate;
  const severeRentBurden = props.severe_rent_burden_rate;
  let renterRate = props.renter_rate;
  if (renterRate != null) {
    const r = parseFloat(renterRate);
    renterRate = (r >= 0 && r <= 1) ? +(r * 100).toFixed(1) : +r.toFixed(1);
  }

  return {
    name: cleanGeoName(props.display_name || props.NAME || props.name),
    population: formatNumber(props.total_population),
    medianIncome: formatNumber(medianIncome, { isCurrency: true }),
    incomeVsState: getComparison(medianIncome, stateEcon.median_income, 'state', true),
    medianRent: formatNumber(medianRent, { isCurrency: true }),
    rentVsState: getComparison(medianRent, stateHousing.median_rent, 'state', true),
    aliceRate: formatNumber(aliceRate, { isPercent: true }),
    aliceFraction: getFractionText(aliceRate, 'households') || 'many households',
    snapRate: formatNumber(snapRate, { isPercent: true }),
    snapTotal: formatNumber(snapTotal, { isCurrency: true }),
    avgMonthlyBenefit: formatNumber(monthlyBenefit, { isCurrency: true, decimals: 2 }),
    dailyPerHousehold: formatNumber(dailyPerHousehold, { isCurrency: true, decimals: 2 }),
    ctcAvg: formatNumber(props.ctc_avg_amount, { isCurrency: true }),
    ctcRate: formatNumber(props.ctc_participation_rate, { isPercent: true }),
    eitcAvg: formatNumber(props.federal_eitc_avg_amount, { isCurrency: true }),
    eitcRate: formatNumber(props.eitc_participation_rate, { isPercent: true }),
    stateEitcAvg: formatNumber(props.state_eitc_avg_amount, { isCurrency: true }),
    travelTime: formatNumber(props.travel_time_to_work_minutes, { decimals: 1 }),
    transitPct: formatNumber(props.public_transportation_pct, { isPercent: true }),
    renterRate: renterRate != null ? renterRate + '%' : 'N/A',
    rentBurden: formatNumber(rentBurden, { isPercent: true }),
    rentBurdenFraction: getFractionText(parseFloat(rentBurden) || 0, 'renters') || 'N/A',
    severeRentBurden: formatNumber(severeRentBurden, { isPercent: true }),
    severeRentBurdenFraction: getFractionText(parseFloat(severeRentBurden) || 0, 'renters') || 'N/A',
    cepDisplay: props.cep_display || 'N/A',
    cepPct: formatNumber(props.cep_percentage, { isPercent: true }),
    totalSchools: props.total_schools || 'N/A',
    cepSchools: props.cep_schools || 'N/A',
  };
}
