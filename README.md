# Fit plan local

Jednoducha lokalni appka na planovani treninku ve fitku. Bezi bez databaze,
umi bezet v lokalnim rezimu, ale je pripravena i na Supabase login, cloud
databazi, public feed a leaderboard.

## Spusteni

```powershell
npm start
```

Pak otevri:

```text
http://localhost:4173
```

Data se ukladaji do `localStorage` v prohlizeci. V appce je i export/import JSON.

## Supabase cloud

1. Vytvor Supabase projekt.
2. V SQL editoru spust `supabase-schema.sql`.
3. Do `supabase-config.js` dopln `SUPABASE_URL` a `SUPABASE_ANON_KEY`.
4. Spust appku znovu. Prihlaseni/registrace se objevi automaticky.

`SUPABASE_ANON_KEY` je verejny browserovy klic. Bezpecnost drzi Row Level
Security policy v `supabase-schema.sql`.

## Online zdarma

Nejlevnejsi deploy je GitHub Pages + Supabase Free. Presny postup je v
`DEPLOY.md`.

## Mobil

Appka ma zaklad PWA (`manifest.webmanifest` a `sw.js`). Na iPhonu/Androidu ji
muzes otevrit v prohlizeci a pridat na plochu bez App Storu.
