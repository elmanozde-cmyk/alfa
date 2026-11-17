// Polar izin ekranından dönüş: kodu uygulamaya ilet (adres sabit, başka yere yönlendirmez)
const APP_URL = 'https://elmanozde-cmyk.github.io/alfa/';

Deno.serve((req) => {
  const from = new URL(req.url);
  const to = new URL(APP_URL);
  for (const k of ['code', 'state', 'error', 'error_description']) {
    const v = from.searchParams.get(k);
    if (v) to.searchParams.set(`polar_${k}`, v);
  }
  return new Response(null, { status: 302, headers: { Location: to.toString() } });
});
