// İzim · Polar bağlantısı
// İstek: POST { action: 'connect', code } | { action: 'sync' } | { action: 'unlink' }
// Kullanıcının Supabase oturumu Authorization başlığıyla gelir; veriler onun yetkisiyle yazılır (RLS).
import { createClient } from 'npm:@supabase/supabase-js@2.89.0';
import { POLAR_API, POLAR_TOKEN, syncPolar } from './lib.ts';

const CLIENT_ID = Deno.env.get('POLAR_CLIENT_ID') ?? 'f8fad51a-0852-4b12-b466-cea873bd086d';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/polar-callback`;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

function polarSecret(): string | undefined {
  // Supabase'e eklenen gizli anahtar; olası isimlerin hepsine bak
  return Deno.env.get('POLAR_CLIENT_SECRET') ?? Deno.env.get('POLAR_SECRET') ?? Deno.env.get('POLAR_SECRET_KEY');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const apikey = req.headers.get('apikey') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const sb = createClient(SUPABASE_URL, apikey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user } } = await sb.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''));
    if (!user) return json({ error: 'not_signed_in' }, 401);

    const { action, code } = await req.json().catch(() => ({}));

    const db = {
      async existingIds(ids: string[]) {
        const { data, error } = await sb.from('walks').select('id').in('id', ids);
        if (error) throw error;
        return new Set((data ?? []).map((r: { id: string }) => r.id));
      },
      async saveWalk(id: string, walk: Record<string, unknown>) {
        const { error } = await sb.from('walks').upsert({
          user_id: user.id, id, deleted: false, data: walk, start_at: new Date(walk.start as number).toISOString(),
        }, { onConflict: 'user_id,id' });
        if (error) throw error;
      },
      async markSynced() {
        await sb.from('polar_links').update({ last_sync: new Date().toISOString() }).eq('user_id', user.id);
      },
    };

    if (action === 'connect') {
      const secret = polarSecret();
      if (!secret) return json({ error: 'missing_secret' }, 500);
      if (!code) return json({ error: 'missing_code' }, 400);
      const tr = await fetch(POLAR_TOKEN, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${CLIENT_ID}:${secret}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json;charset=UTF-8',
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      });
      if (!tr.ok) return json({ error: 'token_failed', detail: (await tr.text()).slice(0, 300) }, 400);
      const tok = await tr.json();
      // Kullanıcıyı uygulamamıza kaydet (zaten kayıtlıysa 409 döner, sorun değil)
      const reg = await fetch(`${POLAR_API}/users`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ 'member-id': user.id }),
      });
      if (!reg.ok && reg.status !== 409) return json({ error: 'register_failed', detail: (await reg.text()).slice(0, 300) }, 400);
      const { error } = await sb.from('polar_links').upsert({
        user_id: user.id, polar_user_id: tok.x_user_id, access_token: tok.access_token, linked_at: new Date().toISOString(),
      });
      if (error) throw error;
      const result = await syncPolar(tok.access_token, db);
      return json({ linked: true, ...result });
    }

    const { data: link, error: linkErr } = await sb.from('polar_links')
      .select('polar_user_id, access_token').eq('user_id', user.id).maybeSingle();
    if (linkErr) throw linkErr;
    if (!link) return json({ linked: false });

    if (action === 'sync') {
      const result = await syncPolar(link.access_token, db);
      return json({ linked: true, ...result });
    }

    if (action === 'unlink') {
      await fetch(`${POLAR_API}/users/${link.polar_user_id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${link.access_token}` },
      }).catch(() => {});
      const { error } = await sb.from('polar_links').delete().eq('user_id', user.id);
      if (error) throw error;
      return json({ linked: false });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
    return json({ error: msg }, msg === 'polar_unauthorized' ? 401 : 500);
  }
});
