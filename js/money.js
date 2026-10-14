// Exact money arithmetic. Every amount is an integer count of the currency's
// smallest unit (ISO 4217 minor unit), handled as BigInt. No floating point.

// [ISO code, name, minor-unit exponent]
export const CURRENCIES = [
  ["AED","UAE dirham",2],["AUD","Australian dollar",2],["BHD","Bahraini dinar",3],["BND","Brunei dollar",2],
  ["BRL","Brazilian real",2],["CAD","Canadian dollar",2],["CHF","Swiss franc",2],["CLP","Chilean peso",0],
  ["CNY","Chinese yuan",2],["DKK","Danish krone",2],["EUR","Euro",2],["GBP","Pound sterling",2],
  ["HKD","Hong Kong dollar",2],["IDR","Indonesian rupiah",2],["INR","Indian rupee",2],["IQD","Iraqi dinar",3],
  ["ISK","Icelandic króna",0],["JOD","Jordanian dinar",3],["JPY","Japanese yen",0],["KHR","Cambodian riel",2],
  ["KRW","South Korean won",0],["KWD","Kuwaiti dinar",3],["LAK","Lao kip",2],["LKR","Sri Lankan rupee",2],
  ["LYD","Libyan dinar",3],["MMK","Myanmar kyat",2],["MOP","Macanese pataca",2],["MXN","Mexican peso",2],
  ["MYR","Malaysian ringgit",2],["NOK","Norwegian krone",2],["NZD","New Zealand dollar",2],["OMR","Omani rial",3],
  ["PHP","Philippine peso",2],["PYG","Paraguayan guaraní",0],["QAR","Qatari riyal",2],["SAR","Saudi riyal",2],
  ["SEK","Swedish krona",2],["SGD","Singapore dollar",2],["THB","Thai baht",2],["TND","Tunisian dinar",3],
  ["TRY","Turkish lira",2],["TWD","New Taiwan dollar",2],["UGX","Ugandan shilling",0],["USD","US dollar",2],
  ["VND","Vietnamese đồng",0],["XAF","Central African CFA franc",0],["XOF","West African CFA franc",0],["ZAR","South African rand",2]
];
export const COMMON = ["IDR","USD","SGD","MYR","THB","JPY","AUD","EUR"];
export const CUR = Object.fromEntries(CURRENCIES.map(([c, n, e]) => [c, { code: c, name: n, exp: e }]));

const P10 = n => 10n ** BigInt(n);

function parseDecimal(str) {
  const s = String(str ?? "").trim().replace(/[,\s_]/g, "");
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && !m[3])) return null;
  return { neg: !!m[1], int: m[2] || "0", frac: m[3] || "" };
}

/** Text -> { value: BigInt minor units } or { error }. Rejects more decimals than the currency has. */
export function parseAmount(str, exp) {
  const d = parseDecimal(str);
  if (!d) return { error: "Enter an amount using digits and a dot for decimals, e.g. 125.50" };
  if (d.frac.length > exp) {
    return { error: exp === 0 ? "This currency has no smaller unit. Enter a whole number."
      : `This currency goes down to ${exp} decimal place${exp > 1 ? "s" : ""}.` };
  }
  let v = BigInt(d.int + d.frac.padEnd(exp, "0"));
  if (d.neg) v = -v;
  if (v === 0n) return { error: "Amount can't be zero." };
  return { value: v };
}

/** Rate = how many units of home currency one unit of the paid currency buys. Up to 12 decimals. */
export function parseRate(str) {
  const d = parseDecimal(str);
  if (!d || d.neg) return null;
  const frac = d.frac.replace(/0+$/, "");
  if (frac.length > 12) return null;
  const num = BigInt(d.int + frac);
  if (num === 0n) return null;
  return { num, scale: frac.length, text: d.int.replace(/^0+(?=\d)/, "") + (frac ? "." + frac : "") };
}

/** Integer division rounding half away from zero. */
export function divRound(n, d) {
  const neg = n < 0n, a = neg ? -n : n;
  let q = a / d;
  if ((a % d) * 2n >= d) q += 1n;
  return neg ? -q : q;
}

/** Convert minor units of the paid currency to minor units of the home currency. */
export function convert(minor, srcExp, rate, baseExp) {
  return divRound(BigInt(minor) * rate.num * P10(baseExp), P10(rate.scale + srcExp));
}

/** Minor units -> display string, e.g. fmt(123456n, 2) = "1,234.56". */
export function fmt(minor, exp, group = true) {
  minor = BigInt(minor);
  const neg = minor < 0n;
  const s = (neg ? -minor : minor).toString().padStart(exp + 1, "0");
  let i = s.slice(0, s.length - exp);
  const f = exp ? s.slice(-exp) : "";
  if (group) i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? (group ? "−" : "-") : "") + i + (exp ? "." + f : "");
}

export const money = (minor, code, exp) => `${code} ${fmt(minor, exp)}`;
export const unitText = exp => exp === 0 ? "1" : "0." + "0".repeat(exp - 1) + "1";
