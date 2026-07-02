// ── License / Subscription Verification ──
//
// STUB IMPLEMENTATION.
//
// This module is the single seam through which subscription status is checked.
// Right now it verifies keys locally against a small allow-list + a format
// rule, so the whole app flow works offline with no backend. When you are
// ready to gate on a real subscription, replace the body of `verifyLicense`
// with a call to Supabase / Firebase — the rest of the app only depends on the
// returned shape: { valid: boolean, plan: string, reason?: string }.
//
// Example real implementation (Supabase):
//   const res = await fetch(`${SUPABASE_URL}/rest/v1/licenses?key=eq.${key}`, {
//     headers: { apikey: SUPABASE_ANON_KEY }
//   });
//   const rows = await res.json();
//   return rows[0]?.active ? { valid: true, plan: rows[0].plan } : { valid: false, reason: 'inactive' };

// Keys accepted by the stub. Anything matching DEV-XXXX-XXXX also passes so
// teachers/testers don't need a real key during this build.
const ALLOWED_KEYS = new Set([
  'PRO-2026-TEACHER',
  'DEMO-DEMO-DEMO',
]);

const DEV_KEY_PATTERN = /^DEV-[A-Z0-9]{4}-[A-Z0-9]{4}$/i;

/**
 * Verify a license key. Async on purpose so swapping in a network-backed
 * implementation later requires no call-site changes.
 *
 * @param {string} key
 * @returns {Promise<{valid: boolean, plan: string, reason?: string}>}
 */
async function verifyLicense(key) {
  const trimmed = (key || '').trim();

  if (!trimmed) {
    return { valid: false, plan: 'none', reason: 'No license key provided.' };
  }

  if (ALLOWED_KEYS.has(trimmed.toUpperCase()) || DEV_KEY_PATTERN.test(trimmed)) {
    return { valid: true, plan: 'pro' };
  }

  return {
    valid: false,
    plan: 'none',
    reason: 'Key not recognised. (Stub accepts PRO-2026-TEACHER, DEMO-DEMO-DEMO, or any DEV-XXXX-XXXX key.)',
  };
}

module.exports = { verifyLicense };
