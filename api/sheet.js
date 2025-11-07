import { google } from 'googleapis';

function bad(res, code, msg, extra = {}) {
  res.status(code).json({ ok: false, error: msg, ...extra });
}

export default async function handler(req, res) {
  try {
    // --- simple anti-abuse (optional) ---
    const secret = process.env.SIGNING_SECRET;
    if (secret && req.headers['x-proxy-secret'] !== secret) {
      return bad(res, 401, 'unauthorized');
    }

    // --- inputs ---
    const q = req.method === 'GET' ? req.query : req.body || {};
    const spreadsheetId = q.id;
    const range = q.range || 'Sheet1!A1:D';
    const format = q.format || 'rows';   // 'rows' or 'matrix'

    if (!spreadsheetId) return bad(res, 400, 'missing id');

    // --- service account auth ---
    const sa = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const jwt = new google.auth.JWT(
      sa.client_email,
      null,
      sa.private_key,
      ['https://www.googleapis.com/auth/spreadsheets.readonly']
    );
    await jwt.authorize();

    const sheets = google.sheets({ version: 'v4', auth: jwt });

    // --- short per-request timeout (avoid 20s platform kills) ---
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    let resp;
    try {
      resp = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
        auth: jwt,
        // googleapis uses gaxios under the hood; abort via signal
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    const values = resp?.data?.values || [];

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
    const H = header.map(h => String(h || '').trim());
    const json = rows.map(r => {
      const o = {};
      H.forEach((h, i) => { o[h || `col_${i+1}`] = String(r[i] ?? ''); });
      return o;
    });

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ ok: true, rows: json, count: json.length });

  } catch (e) {
    const detail = e?.response?.data || e?.message || String(e);
    return bad(res, 500, 'sheets error', { detail });
  }
}

