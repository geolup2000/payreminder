// Decimal parsing avoids both partial parseFloat acceptance and floating-point
// multiplication/rounding. Persisted amounts stay numbers for JSON compatibility.
function toCents(value) {
  if (typeof value !== 'number' && typeof value !== 'string') throw new TypeError('Invalid money amount');
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new TypeError('Invalid money amount: use non-negative values with at most two decimals');
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Amount exceeds safe integer cents');
  return Number(cents);
}

function fromCents(cents) {
  const amount = cents / 100;
  if (toCents(amount) !== cents) throw new RangeError('Amount cannot represent exact cents as a JSON number');
  return amount;
}

function normalizeAmount(value) {
  return fromCents(toCents(value));
}

// Only for values read from old JSON. Old prepaid arithmetic multiplied binary
// floats before writing. Accept numeric residue within 2 * epsilon * magnitude
// (at most four ULP), capped at 1e-9 currency units, never decimal strings.
// New input and detached member accessors must continue to use normalizeAmount.
function normalizePersistedAmount(value) {
  try { return normalizeAmount(value); }
  catch (error) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw error;
    const cents = Math.round(value * 100);
    if (!Number.isSafeInteger(cents)) throw error;
    const normalized = fromCents(cents);
    const tolerance = Math.min(2 * Number.EPSILON * Math.abs(value), 1e-9);
    if (Math.abs(value - normalized) > tolerance) throw error;
    return normalized;
  }
}

function multiplyAmount(amount, months) {
  if (!Number.isSafeInteger(months) || months < 1) throw new TypeError('Month count must be a positive safe integer');
  const cents = BigInt(toCents(amount)) * BigInt(months);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Amount exceeds safe integer cents');
  return fromCents(Number(cents));
}

module.exports = { toCents, normalizeAmount, normalizePersistedAmount, multiplyAmount };
