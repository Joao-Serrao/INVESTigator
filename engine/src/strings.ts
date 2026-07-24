/** Small string helpers that mirror Python str methods exactly. */

/** Python str.title(): capitalise the first letter of each alphabetic run and
 * lower-case the rest. Non-letters (digits, "_") are word boundaries, so
 * "every_3_days".title() == "Every_3_Days". */
export function pyTitle(s: string): string {
  return s.replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}
