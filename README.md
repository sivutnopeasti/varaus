# Varausjärjestelmä

Multi-tenant ajanvarausjärjestelmä. Jokainen yrittäjä rekisteröi oman tilin ja saa uniikin varaussivun.

**Stack:** Cloudflare Workers + D1 (backend) · GitHub Pages (frontend)
**Kustannus:** ~0 € (CF free tier: 100k req/pv, D1 5 GB)

## Ominaisuudet

- Yrittäjä luo tilin → saa varaussivun `varaa.html?yritys=<slug>`
- Hallintapaneeli: varaukset, palvelut, aukioloajat, yrityksen tiedot
- JWT-autentikaatio (HMAC-SHA256, Web Crypto API)
- Salasanat: PBKDF2, 100 000 iteraatiota
- Ei ulkoisia riippuvuuksia

## Käyttöönotto

### 1. D1-tietokanta

```bash
npx wrangler d1 create varaus-db
# Kopioi database_id → worker/wrangler.toml
npx wrangler d1 execute varaus-db --file=worker/schema.sql
```

### 2. JWT-salaisuus

```bash
npx wrangler secret put JWT_SECRET
# Syötä pitkä satunnainen merkkijono (esim. openssl rand -hex 32)
```

### 3. Deployta Worker

```bash
cd worker
npx wrangler deploy
# Worker URL: https://varaus-api.<subdomain>.workers.dev
```

### 4. Frontend

Päivitä `frontend/config.js`:
```js
const API = 'https://varaus-api.<subdomain>.workers.dev';
```

Laita `frontend/`-hakemiston tiedostot GitHub Pagesiin tai muuhun staattiseen hostiin.

## Sivut

| Sivu | Kuvaus |
|------|--------|
| `rekisteroidy.html` | Uuden yrittäjätilin luonti |
| `hallinta.html` | Admin-paneeli (kirjautuminen + hallinta) |
| `varaa.html?yritys=<slug>` | Asiakkaan varaussivu |

## API-reitit

| Metodi | Reitti | Kuvaus |
|--------|--------|--------|
| GET | `/api/yritys/:slug` | Yritystiedot + palvelut (julkinen) |
| GET | `/api/yritys/:slug/vapaat?date=&palvelu_id=` | Vapaat aikaslotit |
| POST | `/api/varaukset` | Tee varaus |
| POST | `/api/auth/rekisteroidy` | Luo tili |
| POST | `/api/auth/kirjaudu` | Kirjaudu (palauttaa JWT) |
| GET/PUT | `/api/admin/yritys` | Omat tiedot |
| GET/POST/PUT/DELETE | `/api/admin/palvelut` | Palvelut |
| GET/POST | `/api/admin/aukioloajat` | Aukioloajat |
| GET/DELETE | `/api/admin/varaukset` | Varaukset |
