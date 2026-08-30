// Starter registry of holiday notification sources.
//
// India has no RSS/API for gazette holiday notifications. Central holidays are
// published yearly by DoPT as an Office Memorandum; state holidays are published
// individually by each state's General Administration Department, in wildly
// different formats (PDF, HTML table, or not published online at all).
//
// isOfficial:true  -> a .gov.in / government notification/circular page
// isOfficial:false -> a trusted aggregator used as a fallback when no official
//                      machine-parseable source exists for that state/year yet.
//                      Candidates from these are always confidence:'low' or
//                      'medium' and require manual review before publishing.
//
// This list is intentionally a starting point, not exhaustive — admins can add,
// edit, or disable sources from the admin UI as better official URLs are found.

const CENTRAL_SOURCES = [
  {
    name: 'DoPT — Circulars (Central Government Holidays)',
    scope: 'central',
    stateCode: null,
    url: 'https://dopt.gov.in/acts-rules/circulars',
    kind: 'html',
    parserKey: 'dopt-central',
    isOfficial: true,
  },
  {
    name: 'India.gov.in Holiday Calendar (Central)',
    scope: 'central',
    stateCode: null,
    url: 'https://www.india.gov.in/calendar/holiday-calendar',
    kind: 'html',
    parserKey: 'generic-holiday-list',
    isOfficial: true,
  },
];

// A handful of states with a known, directly fetchable official notification
// page. Everything else falls back to the aggregator source below until an
// official URL is added via the admin UI.
const STATE_OFFICIAL_SOURCES = [
  {
    name: 'Delhi — GAD Public Holidays',
    scope: 'state',
    stateCode: 'DL',
    url: 'https://gad.delhi.gov.in/gad/public-holiday',
    kind: 'html',
    parserKey: 'generic-holiday-list',
    isOfficial: true,
  },
  {
    name: 'Maharashtra — GAD Public Holidays',
    scope: 'state',
    stateCode: 'MH',
    url: 'https://gad.maharashtra.gov.in/1145/Public-Holidays',
    kind: 'html',
    parserKey: 'generic-holiday-list',
    isOfficial: true,
  },
  {
    name: 'Karnataka — DPAR Government Holidays',
    scope: 'state',
    stateCode: 'KA',
    url: 'https://dpar.karnataka.gov.in/info-2/Government+Holidays/kn',
    kind: 'html',
    parserKey: 'generic-holiday-list',
    isOfficial: true,
  },
];

const ALL_STATE_CODES = [
  'AP','AR','AS','BR','CG','GA','GJ','HR','HP','JH','KA','KL','MP','MH','MN','ML','MZ','NL','OD',
  'PB','RJ','SK','TN','TG','TR','UP','UK','WB',
  'AN','CH','DN','DL','JK','LA','LD','PY',
];

function aggregatorSlug(stateCode) {
  const SLUGS = {
    AP: 'andhra-pradesh', AR: 'arunachal-pradesh', AS: 'assam', BR: 'bihar', CG: 'chhattisgarh',
    GA: 'goa', GJ: 'gujarat', HR: 'haryana', HP: 'himachal-pradesh', JH: 'jharkhand',
    KA: 'karnataka', KL: 'kerala', MP: 'madhya-pradesh', MH: 'maharashtra', MN: 'manipur',
    ML: 'meghalaya', MZ: 'mizoram', NL: 'nagaland', OD: 'odisha', PB: 'punjab', RJ: 'rajasthan',
    SK: 'sikkim', TN: 'tamil-nadu', TG: 'telangana', TR: 'tripura', UP: 'uttar-pradesh',
    UK: 'uttarakhand', WB: 'west-bengal', AN: 'andaman-and-nicobar-islands', CH: 'chandigarh',
    DN: 'dadra-and-nagar-haveli', DL: 'delhi', JK: 'jammu-and-kashmir',
    LA: 'ladakh', LD: 'lakshadweep', PY: 'puducherry',
  };
  return SLUGS[stateCode] || stateCode.toLowerCase();
}

function buildFallbackAggregatorSources() {
  const officialCodes = new Set(STATE_OFFICIAL_SOURCES.map((s) => s.stateCode));
  return ALL_STATE_CODES
    .filter((code) => !officialCodes.has(code))
    .map((code) => ({
      name: `PublicHolidays.in — ${code} (fallback, non-official)`,
      scope: 'state',
      stateCode: code,
      url: `https://publicholidays.in/${aggregatorSlug(code)}/`,
      kind: 'html',
      parserKey: 'publicholidays-in',
      isOfficial: false,
    }));
}

function getSeedSources() {
  return [
    ...CENTRAL_SOURCES,
    ...STATE_OFFICIAL_SOURCES,
    ...buildFallbackAggregatorSources(),
  ];
}

module.exports = { getSeedSources, ALL_STATE_CODES };
