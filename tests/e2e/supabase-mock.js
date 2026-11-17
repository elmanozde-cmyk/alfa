// Testler için sahte Supabase istemcisi: veriler test sürecinde (window.__db) tutulur
window.supabase = { createClient() {
  const u = { id: 'u1', email: 'test@ornek.com' };
  const auth = {
    onAuthStateChange(f) { setTimeout(() => f('INITIAL_SESSION', localStorage.getItem('mockAuth') ? { user: u } : null), 50); return { data: { subscription: { unsubscribe() {} } } }; },
    async signInWithOtp() { return { error: null }; }, async signOut() { return { error: null }; },
  };
  const functions = { async invoke(name, { body }) { const r = await window.__db({ op: 'fn', name, body }); return r.error ? { data: null, error: { message: r.error, context: { json: async () => ({ error: r.error }) } } } : { data: r.data, error: null }; } };
  return { auth, functions, from(table) {
    const q = { op: 'select', table };
    const b = {
      upsert(rows) { return window.__db({ op: 'upsert', rows }); },
      select() { return b; }, gt(c, v) { q.since = v; return b; }, order() { return b; },
      range(a, z) { q.from = a; q.to = z; return window.__db(q); },
      maybeSingle() { return window.__db({ op: 'polar_status' }); },
    };
    return b;
  } };
} };
