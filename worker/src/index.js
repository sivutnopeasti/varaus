// Varausjärjestelmä – Cloudflare Worker API
// Tietokanta: D1 (SQLite)  |  Auth: JWT + PBKDF2

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const json  = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const err   = (msg, s = 400) => json({ error: msg }, s);

// ─── JWT ────────────────────────────────────────────────────────────────────

const b64url = obj => btoa(JSON.stringify(obj)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const fromb64 = s => atob(s.replace(/-/g,'+').replace(/_/g,'/'));

async function signJWT(payload, secret) {
  const hdr = b64url({ alg: 'HS256', typ: 'JWT' });
  const pld = b64url(payload);
  const data = hdr + '.' + pld;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return data + '.' + btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

async function verifyJWT(token, secret) {
  try {
    const [h, p, s] = token.split('.');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sig = Uint8Array.from(fromb64(s), c => c.charCodeAt(0));
    if (!await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(h + '.' + p))) return null;
    const payload = JSON.parse(fromb64(p));
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch { return null; }
}

// ─── Salasana (PBKDF2) ──────────────────────────────────────────────────────

async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  const toHex = b => Array.from(b).map(x => x.toString(16).padStart(2,'0')).join('');
  return toHex(salt) + ':' + toHex(new Uint8Array(bits));
}

async function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return Array.from(new Uint8Array(bits)).map(x => x.toString(16).padStart(2,'0')).join('') === hashHex;
}

// ─── Auth helper ────────────────────────────────────────────────────────────

async function getAuth(req, env) {
  const h = req.headers.get('Authorization') || '';
  if (!h.startsWith('Bearer ')) return null;
  return verifyJWT(h.slice(7), env.JWT_SECRET);
}

// ─── Aika-apufunktiot ────────────────────────────────────────────────────────

const toMin  = t => { const [h,m] = t.split(':').map(Number); return h*60+m; };
const toTime = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const addMin = (t, m) => toTime(toMin(t) + m);

function generateSlots(open, close, durMin, booked) {
  const slots = [];
  let cur = toMin(open);
  const end = toMin(close);
  while (cur + durMin <= end) {
    const s = toTime(cur);
    const conflict = booked.some(b => toMin(b.start_time) < cur + durMin && toMin(b.end_time) > cur);
    if (!conflict) slots.push(s);
    cur += 30;
  }
  return slots;
}

// ─── Router ─────────────────────────────────────────────────────────────────

export default {
  async fetch(req, env) {
    const url  = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      // ── Julkinen: yritystiedot + palvelut ──────────────────────────────
      if (method === 'GET' && /^\/api\/yritys\/[\w-]+$/.test(path)) {
        const slug = path.split('/').pop();
        const biz = await env.DB.prepare(
          'SELECT id, name, slug, phone, address, description FROM businesses WHERE slug = ?'
        ).bind(slug).first();
        if (!biz) return err('Yritystä ei löydy', 404);
        const { results: services } = await env.DB.prepare(
          'SELECT id, name, duration_min, price_cents, description FROM services WHERE business_id = ? AND is_active = 1 ORDER BY id'
        ).bind(biz.id).all();
        return json({ ...biz, services });
      }

      // ── Julkinen: vapaat ajat ──────────────────────────────────────────
      if (method === 'GET' && /^\/api\/yritys\/[\w-]+\/vapaat$/.test(path)) {
        const slug      = path.split('/')[3];
        const date      = url.searchParams.get('date');
        const palveluId = url.searchParams.get('palvelu_id');
        if (!date || !palveluId) return err('date ja palvelu_id vaaditaan');

        const biz = await env.DB.prepare('SELECT id FROM businesses WHERE slug = ?').bind(slug).first();
        if (!biz) return err('Yritystä ei löydy', 404);

        const service = await env.DB.prepare(
          'SELECT duration_min FROM services WHERE id = ? AND business_id = ? AND is_active = 1'
        ).bind(palveluId, biz.id).first();
        if (!service) return err('Palvelua ei löydy', 404);

        const d = new Date(date + 'T12:00:00+02:00');
        const dow = d.getDay();

        const avail = await env.DB.prepare(
          'SELECT start_time, end_time FROM availability WHERE business_id = ? AND day_of_week = ?'
        ).bind(biz.id, dow).first();
        if (!avail) return json({ slots: [] });

        const { results: booked } = await env.DB.prepare(
          "SELECT start_time, end_time FROM bookings WHERE business_id = ? AND date = ? AND status != 'cancelled'"
        ).bind(biz.id, date).all();

        return json({ slots: generateSlots(avail.start_time, avail.end_time, service.duration_min, booked) });
      }

      // ── Julkinen: tee varaus ───────────────────────────────────────────
      if (method === 'POST' && path === '/api/varaukset') {
        const { slug, palvelu_id, date, start_time, customer_name, customer_email, customer_phone, notes } = await req.json();
        if (!slug || !palvelu_id || !date || !start_time || !customer_name || !customer_email)
          return err('Pakolliset kentät puuttuvat');

        const biz = await env.DB.prepare('SELECT id FROM businesses WHERE slug = ?').bind(slug).first();
        if (!biz) return err('Yritystä ei löydy', 404);

        const svc = await env.DB.prepare(
          'SELECT duration_min FROM services WHERE id = ? AND business_id = ? AND is_active = 1'
        ).bind(palvelu_id, biz.id).first();
        if (!svc) return err('Palvelua ei löydy', 404);

        const end_time = addMin(start_time, svc.duration_min);

        const conflict = await env.DB.prepare(
          "SELECT id FROM bookings WHERE business_id=? AND date=? AND status!='cancelled' AND start_time<? AND end_time>?"
        ).bind(biz.id, date, end_time, start_time).first();
        if (conflict) return err('Aika ei ole enää vapaana', 409);

        const r = await env.DB.prepare(
          'INSERT INTO bookings (business_id,service_id,date,start_time,end_time,customer_name,customer_email,customer_phone,notes) VALUES (?,?,?,?,?,?,?,?,?)'
        ).bind(biz.id, palvelu_id, date, start_time, end_time, customer_name, customer_email, customer_phone||null, notes||null).run();

        return json({ ok: true, booking_id: r.meta.last_row_id }, 201);
      }

      // ── Auth: rekisteröinti ────────────────────────────────────────────
      if (method === 'POST' && path === '/api/auth/rekisteroidy') {
        const { name, email, password, slug } = await req.json();
        if (!name || !email || !password || !slug) return err('Kaikki kentät vaaditaan');
        if (password.length < 8)                   return err('Salasana: vähintään 8 merkkiä');
        if (!/^[a-z0-9-]{2,40}$/.test(slug))       return err('URL-tunnus: 2–40 merkkiä, vain a-z 0-9 ja -');

        const exists = await env.DB.prepare('SELECT id FROM businesses WHERE email=? OR slug=?').bind(email, slug).first();
        if (exists) return err('Sähköposti tai URL-tunnus on jo käytössä');

        await env.DB.prepare('INSERT INTO businesses (name,email,password_hash,slug) VALUES (?,?,?,?)')
          .bind(name, email, await hashPassword(password), slug).run();
        return json({ ok: true }, 201);
      }

      // ── Auth: kirjautuminen ────────────────────────────────────────────
      if (method === 'POST' && path === '/api/auth/kirjaudu') {
        const { email, password } = await req.json();
        if (!email || !password) return err('Sähköposti ja salasana vaaditaan');

        const biz = await env.DB.prepare('SELECT id,name,slug,password_hash FROM businesses WHERE email=?').bind(email).first();
        if (!biz || !await verifyPassword(password, biz.password_hash))
          return err('Väärä sähköposti tai salasana', 401);

        const token = await signJWT(
          { sub: biz.id, name: biz.name, slug: biz.slug, exp: Math.floor(Date.now()/1000) + 86400*30 },
          env.JWT_SECRET
        );
        return json({ token, name: biz.name, slug: biz.slug });
      }

      // ── Admin: omat tiedot ─────────────────────────────────────────────
      if (method === 'GET' && path === '/api/admin/yritys') {
        const auth = await getAuth(req, env);
        if (!auth) return err('Kirjautuminen vaaditaan', 401);
        return json(await env.DB.prepare(
          'SELECT id,name,slug,email,phone,address,description FROM businesses WHERE id=?'
        ).bind(auth.sub).first());
      }

      if (method === 'PUT' && path === '/api/admin/yritys') {
        const auth = await getAuth(req, env);
        if (!auth) return err('Kirjautuminen vaaditaan', 401);
        const { name, phone, address, description } = await req.json();
        await env.DB.prepare('UPDATE businesses SET name=?,phone=?,address=?,description=? WHERE id=?')
          .bind(name, phone||null, address||null, description||null, auth.sub).run();
        return json({ ok: true });
      }

      // ── Admin: palvelut ────────────────────────────────────────────────
      if (method === 'GET' && path === '/api/admin/palvelut') {
        const auth = await getAuth(req, env);
        if (!auth) return err('Kirjautuminen vaaditaan', 401);
        const { results } = await env.DB.prepare('SELECT * FROM services WHERE business_id=? ORDER BY id').bind(auth.sub).all();
        return json(results);
      }

      if (method === 'POST' && path === '/api/admin/palvelut') {
        const auth = await getAuth(req, env);
        if (!auth) return err('Kirjautuminen vaaditaan', 401);
        const { name, duration_min, price_cents, description } = await req.json();
        if (!name || !duration_min) return err('Nimi ja kesto vaaditaan');
        await env.DB.prepare('INSERT INTO services (business_id,name,duration_min,price_cents,description) VALUES (?,?,?,?,?)')
          .bind(auth.sub, name, duration_min, price_cents||null, description||null).run();
        return json({ ok: true }, 201);
      }

      if (method === 'PUT' && /^\/api\/admin\/palvelut\/\d+$/.test(path)) {
        const auth = await getAuth(req, env);
        if (!auth) return err('Kirjautuminen vaaditaan', 401);
        const id = path.split('/').pop();
        const { name, duration_min, price_cents, description, is_active } = await req.json();
        await env.DB.prepare('UPDATE services SET name=?,duration_min=?,price_cents=?,description=?,is_active=? WHERE id=? AND business_id=?')
          .bind(name, duration_min, price_cents||null, description||null, is_active?1:0, id, auth.sub).run();
        return json({ ok: true });
      }

      if (method === 'DELETE' && /^\/api\/admin\/palvelut\/\d+$/.test(path)) {
        const auth = await getAuth(req, env);
        if (!auth) return err('Kirjautuminen vaaditaan', 401);
        await env.DB.prepare('DELETE FROM services WHERE id=? AND business_id=?').bind(path.split('/').pop(), auth.sub).run();
        return json({ ok: true });
      }

      // ── Admin: aukioloajat ─────────────────────────────────────────────
      if (method === 'GET' && path === '/api/admin/aukioloajat') {
        const auth = await getAuth(req, env);
        if (!auth) return err('Kirjautuminen vaaditaan', 401);
        const { results } = await env.DB.prepare('SELECT * FROM availability WHERE business_id=? ORDER BY day_of_week').bind(auth.sub).all();
        return json(results);
      }

      if (method === 'POST' && path === '/api/admin/aukioloajat') {
        const auth = await getAuth(req, env);
        if (!auth) return err('Kirjautuminen vaaditaan', 401);
        const { slots } = await req.json();
        await env.DB.prepare('DELETE FROM availability WHERE business_id=?').bind(auth.sub).run();
        for (const s of (slots || [])) {
          await env.DB.prepare('INSERT INTO availability (business_id,day_of_week,start_time,end_time) VALUES (?,?,?,?)')
            .bind(auth.sub, s.day_of_week, s.start_time, s.end_time).run();
        }
        return json({ ok: true });
      }

      // ── Admin: varaukset ───────────────────────────────────────────────
      if (method === 'GET' && path === '/api/admin/varaukset') {
        const auth = await getAuth(req, env);
        if (!auth) return err('Kirjautuminen vaaditaan', 401);
        const from = url.searchParams.get('from') || new Date().toISOString().split('T')[0];
        const { results } = await env.DB.prepare(`
          SELECT b.*, s.name AS service_name, s.price_cents
          FROM bookings b JOIN services s ON b.service_id = s.id
          WHERE b.business_id=? AND b.date>=? AND b.status!='cancelled'
          ORDER BY b.date, b.start_time
        `).bind(auth.sub, from).all();
        return json(results);
      }

      if (method === 'DELETE' && /^\/api\/admin\/varaukset\/\d+$/.test(path)) {
        const auth = await getAuth(req, env);
        if (!auth) return err('Kirjautuminen vaaditaan', 401);
        await env.DB.prepare("UPDATE bookings SET status='cancelled' WHERE id=? AND business_id=?")
          .bind(path.split('/').pop(), auth.sub).run();
        return json({ ok: true });
      }

      return err('Reittia ei löydy', 404);

    } catch (e) {
      console.error(e);
      return err('Palvelinvirhe: ' + e.message, 500);
    }
  }
};
