const MONTHS_RO = [
  'ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie',
  'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie',
];

function pad(n) {
  return String(n).padStart(2, '0');
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function humanMonth(month) {
  const [y, m] = String(month).split('-');
  const idx = parseInt(m, 10) - 1;
  return `${MONTHS_RO[idx] || m} ${y}`;
}

function localizedMonth(month, language = 'ro') {
  if (language !== 'en') return humanMonth(month);
  const [year, monthNumber] = String(month).split('-').map(Number);
  return new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

function formatMoney(amount, currency = 'RON', language = 'ro') {
  const formatted = Number(amount).toFixed(2);
  return `${language === 'en' ? formatted : formatted.replace('.', ',')} ${currency}`;
}

module.exports = { currentMonth, humanMonth, localizedMonth, formatMoney };
