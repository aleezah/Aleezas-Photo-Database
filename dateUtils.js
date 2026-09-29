// Turns the free-text `date_label` folder names (e.g. "Aug 12", "april 16th",
// "Fatimas 26th- september 17th", "2025-06-16") into a zero-padded, lexicographically
// sortable string "YYYY-MM-DD" (with "00" standing in for an unknown month/day),
// so rolls can be ordered chronologically instead of by raw string comparison.

const MONTH_MAP = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11, novemeber: 11,
  december: 12, dec: 12,
};

const MONTH_ALT = Object.keys(MONTH_MAP).sort((a, b) => b.length - a.length).join('|');
const MONTH_RE = new RegExp(`(?<![a-z])(${MONTH_ALT})(?![a-z])`, 'i');

function pad2(n) { return String(n).padStart(2, '0'); }

// Pull a plausible day number (1-31) out of the text immediately surrounding
// the matched month name, preferring "Month Day" over a stray leading number
// (birthdays like "Fatimas 26th- september 17th" put the real day *after* the month).
function extractDay(before, after) {
  let m = after.match(/^\D{0,3}(\d{1,2})(?!\d)(?:st|nd|rd|th)?\b/);
  if (m) return parseInt(m[1], 10);
  m = before.match(/(?<!\d)(\d{1,2})(?:st|nd|rd|th)?\D{0,3}$/);
  if (m) return parseInt(m[1], 10);
  return null;
}

function parseDateSort(year, dateLabel) {
  const label = (dateLabel || '').trim();

  const iso = label.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return iso[0];

  // An explicit "(YYYY-MM-DD)" or "(YYYY-MM-DD to YYYY-MM-DD)" tag beats any
  // month name guessed from the rest of the label — e.g. "Aleenas 25 Bday
  // (2024-07-02)" or "Chilling at hibs March 2023 (2023-02-24)", where the
  // parenthesized date is the one that was actually confirmed.
  const isoInParens = label.match(/\((\d{4}-\d{2}-\d{2})\b/);
  if (isoInParens) return isoInParens[1];

  const y = year && /^\d{4}$/.test(String(year)) ? String(year) : null;
  if (!y) return null;

  if (!label) return `${y}-00-00`;

  const monthMatch = label.match(MONTH_RE);
  if (!monthMatch) return `${y}-00-00`;

  const month = MONTH_MAP[monthMatch[1].toLowerCase()];
  const before = label.slice(0, monthMatch.index);
  const after  = label.slice(monthMatch.index + monthMatch[0].length);
  const day = extractDay(before, after);

  if (day && day >= 1 && day <= 31) return `${y}-${pad2(month)}-${pad2(day)}`;
  return `${y}-${pad2(month)}-00`;
}

module.exports = { parseDateSort };
