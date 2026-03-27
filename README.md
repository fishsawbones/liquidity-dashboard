# Liquidity Impulse Monitor

4-week rolling: Δ Fed Balance Sheet + (−Δ TGA) + Δ Loans & Leases, with Bitcoin overlay.

## Deploy to Vercel (no GitHub needed)

The fastest path — skip git entirely:

```bash
cd liquidity-dashboard
npm install
npx vercel
```

Vercel CLI will prompt you to log in (opens browser), then deploy. Done.

### Set the FRED API key

After the first deploy, add the env variable so the dashboard auto-loads data:

```bash
npx vercel env add VITE_FRED_API_KEY
```

Paste your FRED key when prompted. Then redeploy:

```bash
npx vercel --prod
```

Or set it in the Vercel dashboard: Project Settings → Environment Variables → add `VITE_FRED_API_KEY`.

Get a free FRED API key at: https://fred.stlouisfed.org/docs/api/api_key.html

## Local dev

```bash
cp .env.example .env 
# edit .env with your FRED key
npm install
npm run dev
```

## FRED Series

- WALCL — Fed total assets (weekly)
- WTREGEN — Treasury General Account (weekly)
- TOTLL — Total loans and leases, all commercial banks (weekly)
- CBBTCUSD — Bitcoin price (daily)
