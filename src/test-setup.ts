// Runs before every test file. Sets fake-but-present env vars so modules
// that read process.env at import time (e.g. lib/mesajClient.ts reading
// MESAJ_API_TOKEN) don't throw "not configured" errors in tests that never
// touch a real Mesaj/Paystack/Supabase account.
process.env.MESAJ_API_TOKEN = process.env.MESAJ_API_TOKEN ?? "test-token";
process.env.MESAJ_API_BASE_URL = process.env.MESAJ_API_BASE_URL ?? "https://mesaj.test";
