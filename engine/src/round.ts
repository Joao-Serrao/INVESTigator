/** Python-compatible rounding.
 *
 * Python's round() and f"{x:.Nf}" use round-half-to-EVEN (banker's rounding);
 * JavaScript's Math.round() and Number.toFixed() round half AWAY FROM ZERO.
 * That difference silently shifts values at exact .5 boundaries — e.g.
 * round(9.625, 2) is 9.62 in Python but 9.63 with Math.round — which can move a
 * score across a severity threshold. Everything numeric that ends up user-visible
 * must go through here so the TypeScript engine matches the Python original.
 */

/** Equivalent of Python's round(x, digits). */
export function pyRound(x: number, digits = 0): number {
  if (!Number.isFinite(x)) return x;
  // Collapse binary representation noise first (e.g. 1.005*100 = 100.49999999999999)
  const n = Number(x.toPrecision(15));
  const f = Math.pow(10, digits);
  const scaled = Number((n * f).toPrecision(15));
  const floor = Math.floor(scaled);
  const frac = scaled - floor;
  let r: number;
  if (frac > 0.5) r = floor + 1;
  else if (frac < 0.5) r = floor;
  else r = floor % 2 === 0 ? floor : floor + 1; // exactly .5 -> nearest even
  return r / f;
}

/** Equivalent of Python's f"{x:.Nf}". */
export function pyFormat(x: number, digits: number): string {
  return pyRound(x, digits).toFixed(digits);
}

/** Equivalent of Python's f"{x:,.0f}". Grouping is done manually rather than via
 * toLocaleString so it doesn't depend on the JS runtime shipping full ICU (a
 * `-small-icu`/no-ICU Android WebView would otherwise drop the thousands commas). */
export function pyThousands(x: number): string {
  const r = pyRound(x, 0);
  const grouped = Math.abs(r).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return r < 0 ? `-${grouped}` : grouped;
}

/** Equivalent of Python's str(float): whole values keep a trailing ".0"
 * (str(8.0) == "8.0"), everything else uses the shortest round-tripping repr,
 * which JS's String() already produces the same way. Used where the narrative
 * interpolates a raw float (e.g. "Urgency 8.0/10"). */
export function pyFloatStr(x: number): string {
  if (!Number.isFinite(x)) {
    if (Number.isNaN(x)) return "nan";
    return x > 0 ? "inf" : "-inf";
  }
  return Number.isInteger(x) ? `${x}.0` : String(x);
}
