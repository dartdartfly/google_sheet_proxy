import type { Request, Response } from 'express';
import express from 'express';
import { google } from 'googleapis';

/* ===== Types & helpers ===== */

type Format = 'rows' | 'matrix';

interface QueryShape {
  id?: string;
  range?: string;
  format?: Format;
  [k: string]: any;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

const bad = (
  res: Response,
  code: number,
  msg: string,
  extra: Record<string, unknown> = {}
) => res.status(code).json({ ok: false, error: msg, ...extra });

/* ===== Core handler (works for GET/POST) ===== */

async function sheetHandler(req: Request, res: Response) {
  try {
    // --- simple anti-abuse (optional) ---
    const secret = process.env.SIGNING_SECRET;
    const incoming = req.header('x-proxy-secret');
    if (secret && incoming !== secret) {
      return bad(res, 401, 'unauthorized');
    }

    // --- inputs ---
    const q: QueryShape =
      req.method === 'GET' ? (req.query as QueryShape) : ((req.body as QueryShape) || {});
    const spreadsheetId = q.id;
    const range = q.range as string;
    const format: Format = ((q.format as Format) || 'matrix');

    if (!spreadsheetId) return bad(res, 400, 'missing id');
    if (!range) return bad(res, 400, 'missing range');

    // --- service account auth ---
    const raw = process.env.GOOGLE_CREDENTIALS;
    if (!raw) return bad(res, 500, 'missing GOOGLE_CREDENTIALS');

    const sa: ServiceAccount = JSON.parse(raw);
    const jwt = new google.auth.JWT(
      sa.client_email,
      undefined,
      sa.private_key,
      ['https://www.googleapis.com/auth/spreadsheets.readonly']
    );
    await jwt.authorize();

    const sheets = google.sheets({ version: 'v4', auth: jwt });

    // --- short per-request timeout (avoid platform hard-kill) ---
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    let resp;
    try {
      // gaxios supports AbortController; types may lag in some versions
      resp = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
        auth: jwt
      });
    } finally {
      clearTimeout(timer);
    }

    const values: string[][] = (resp?.data?.values as string[][]) || [];

    if (format === 'matrix') {
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
      return res.status(200).json({ ok: true, values, count: values.length });
    }

    // header → JSON rows
    if (!values.length) {
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
      return res.status(200).json({ ok: true, rows: [], count: 0 });
    }

    const [header, ...rows] = values;
    const H = (header || []).map(h => String(h ?? '').trim());
    const json = rows.map((r) => {
      const o: Record<string, string> = {};
      H.forEach((h, i) => { o[h || `col_${i + 1}`] = String(r?.[i] ?? ''); });
      return o;
    });

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ ok: true, rows: json, count: json.length });

  } catch (e: any) {
    const detail = e?.response?.data ?? e?.message ?? String(e);
    return bad(res, 500, 'sheets error', { detail });
  }
}

/* ===== Express app wiring for Vercel ===== */

const app = express();

// CORS middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-proxy-secret');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// parsers (Vercel passes raw req/res; create app per invocation is fine for small handlers)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Map both GET and POST to the same logic
app.get('/', sheetHandler);
app.post('/', sheetHandler);

// Vercel expects a default export (req, res) signature:
export default (req: any, res: any) => app(req, res);
