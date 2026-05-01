# Free online deploy

Nejlevnejsi produkcni start:

- Frontend: GitHub Pages za 0 Kc
- Login a databaze: Supabase Free za 0 Kc
- Domena: zatim 0 Kc, resi se pozdeji

Finalni URL bez domeny bude vypadat takhle:

```text
https://pokornydavid.github.io/fit-plan-local/
```

## 1. Supabase

1. Otevri `https://supabase.com/dashboard`.
2. Vytvor novy projekt.
3. V projektu otevri SQL Editor.
4. Vloz obsah `supabase-schema.sql`.
5. Klikni Run.
6. Otevri Project Settings > API.
7. Zkopiruj:
   - Project URL
   - publishable key (`sb_publishable_...`)

Do `supabase-config.js` dopln:

```js
export const SUPABASE_URL = "TVOJE_PROJECT_URL";
export const SUPABASE_ANON_KEY = "TVUJ_PUBLISHABLE_KEY";
```

Nikdy nepouzivej `sb_secret` nebo `service_role` klic ve frontend aplikaci.

Kdyz se schema v budoucnu zmeni, muzes `supabase-schema.sql` spustit znovu.
Soubor je napsany tak, aby znovu vytvoril policies a pridal nove tabulky bez
mazani tvych treningu nebo nutrition dat.

## 2. Supabase Auth URL

V Supabase otevri Authentication > URL Configuration.

Site URL:

```text
https://pokornydavid.github.io/fit-plan-local/
```

Redirect URLs:

```text
http://localhost:4173/
https://pokornydavid.github.io/fit-plan-local/
```

## 3. GitHub Pages

1. Otevri repo `https://github.com/pokornydavid/fit-plan-local`.
2. Settings > Pages.
3. Build and deployment:
   - Source: Deploy from a branch
   - Branch: `main`
   - Folder: `/root`
4. Klikni Save.
5. Pockej minutu.
6. Otevri `https://pokornydavid.github.io/fit-plan-local/`.

## 4. Mobil

Na iPhonu:

1. Otevri appku v Safari.
2. Share.
3. Add to Home Screen.

Na Androidu:

1. Otevri appku v Chrome.
2. Menu.
3. Add to Home screen nebo Install app.
