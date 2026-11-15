import express from 'express';
import fs from 'fs';

const app = express();
app.use(express.json());

// Página inicial
app.get('/', (req, res) => {
  res.redirect('/index.html');
});

// ---------- BANCO LOCAL (db.json) ----------
const DB = 'db.json';
const load = () => {
  const db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : {};
  return {
    profile: db.profile ?? null,
    nasa: db.nasa ?? null,
    nasaErro: db.nasaErro ?? null,
    messages: db.messages ?? [],
    recs: db.recs ?? []
  };
};
const save = (db) => fs.writeFileSync(DB, JSON.stringify(db, null, 2));

// ---------- NASA POWER (estimativa regional, não medição na propriedade) ----------
const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

async function getNasa(lat, lon) {
  if (!Number.isFinite(+lat) || !Number.isFinite(+lon) || lat === '' || lon === '') {
    throw new Error('Latitude/longitude missing.');
  }
  const end = new Date(Date.now() - 3 * 864e5);
  const start = new Date(end - 59 * 864e5);
  const url =
    `https://power.larc.nasa.gov/api/temporal/daily/point` +
    `?parameters=T2M,PRECTOTCORR,ALLSKY_SFC_SW_DWN&community=AG` +
    `&longitude=${encodeURIComponent(lon)}&latitude=${encodeURIComponent(lat)}` +
    `&start=${fmt(start)}&end=${fmt(end)}&format=JSON`;

  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('NASA POWER ' + response.status);
  const p = (await response.json()).properties.parameter;

  const valid = (v) => (v !== undefined && v !== null && v > -900 ? v : null);
  const days = Object.keys(p.T2M).map((d) => ({
    d, t: valid(p.T2M[d]), p: valid(p.PRECTOTCORR[d]), s: valid(p.ALLSKY_SFC_SW_DWN[d])
  }));
  const avg = (k) => {
    const v = days.map((x) => x[k]).filter((x) => x !== null);
    return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : null;
  };
  return {
    fonte: 'NASA POWER (regional estimate)',
    periodo: days.length ? `${days[0].d}-${days[days.length - 1].d}` : 'n/a',
    tempMedia: avg('t'),
    chuvaTotalMm: +days.reduce((s, x) => s + (x.p || 0), 0).toFixed(1),
    radiacaoMedia: avg('s'),
    days
  };
}

// ---------- GEOCODIFICAÇÃO (Open-Meteo, grátis, sem chave) ----------
app.get('/api/geocode', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const lang = ['pt', 'en', 'es'].includes(req.query.lang) ? req.query.lang : 'en';
    if (!q) return res.status(400).json({ error: 'empty' });
    const r = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=${lang}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const g = (await r.json()).results?.[0];
    if (!g) return res.status(404).json({ error: 'notfound' });
    res.json({ cidade: g.name, uf: g.admin1 || '', lat: g.latitude, lon: g.longitude });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- ESTADO E CADASTRO ----------
app.get('/api/state', (req, res) => res.json(load()));

app.post('/api/profile', async (req, res) => {
  const db = load();
  db.profile = req.body;
  try {
    db.nasa = await getNasa(req.body.lat, req.body.lon);
    db.nasaErro = null;
  } catch (e) {
    db.nasa = null;
    db.nasaErro = e.message;
  }
  save(db);
  res.json({ ok: true, nasa: db.nasa, nasaErro: db.nasaErro });
});

// ---------- INSTRUÇÕES DA IA ----------
const LANGS = { pt: 'português do Brasil', en: 'English', es: 'español' };

const system = (lang) => `
Você é o TerraCiclo, assistente agrícola para agricultores familiares.
Ajude o agricultor a entender seu solo, suas culturas, o clima e o manejo.

IDIOMA: responda SEMPRE em ${LANGS[lang]} (campo reply e todos os textos das recomendações), mesmo que o histórico esteja em outro idioma. As chaves do JSON ficam como estão abaixo.

COMUNICAÇÃO:
- Linguagem simples, acolhedora, frases curtas e práticas.
- Responda perguntas livres, considere o histórico, não repita informações.
- Fora do tema agrícola, responda com educação e volte ao objetivo do TerraCiclo.

USO DOS DADOS:
- Use o cadastro e os dados da NASA POWER como contexto real. Use SOMENTE os valores fornecidos; nunca invente números.
- Os dados da NASA são estimativas regionais, não medições da propriedade.
- Temperatura e chuva não informam fertilidade ou nutrientes. Sem análise de solo, não afirme quais nutrientes faltam.
- Se faltar informação, explique e faça perguntas.

RECOMENDAÇÕES:
- Use práticas reconhecidas: rotação, adubação verde, cobertura vegetal, plantas de cobertura, manejo da irrigação, matéria orgânica.
- Considere se a cultura é perene ou anual. Para perenes (ex.: uva, manga), pense em cobertura nas entrelinhas e manejo, nunca em arrancar a cultura sem entender a situação.
- Indique benefícios, cuidados e limitações. Não invente custos ou ganhos; não apresente estimativas como certezas.

FORMATO: responda SOMENTE em JSON válido:
{"reply": "texto simples para o agricultor", "recommendations": []}
Cada item de recommendations (só quando houver base suficiente):
{"titulo":"","motivo":"","beneficios":"","periodo":"","mes_inicio":1,"duracao_meses":3,"etapas":["",""],"custos":"","confianca":"baixa|média|alta","limitacoes":""}
Sem base suficiente, deixe recommendations vazio. Não crie recomendações só para preencher a lista.
`;

// ---------- CHAT (GROQ) ----------
app.post('/api/chat', async (req, res) => {
  try {
    const db = load();
    const message = req.body.message?.trim();
    const lang = LANGS[req.body.lang] ? req.body.lang : 'en';
    if (!message) return res.status(400).json({ error: 'Empty message.' });
    if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY missing in .env file.' });
    if (!db.profile) return res.status(400).json({ error: 'Complete the registration first.' });

    db.messages.push({ role: 'user', text: message });

    const decisoes = db.recs
      .filter((r) => r.status !== 'pendente')
      .map((r) => `${r.titulo}: ${r.status}${r.motivoRecusa ? ' (' + r.motivoRecusa + ')' : ''}`);

    const ctx = `
CADASTRO DO AGRICULTOR:
${JSON.stringify(db.profile)}

DADOS DA NASA POWER (últimos 60 dias, estimativa regional):
${db.nasa ? JSON.stringify({ ...db.nasa, days: undefined }) : 'Indisponíveis'}

DECISÕES ANTERIORES:
${decisoes.join('; ') || 'Nenhuma'}
`;

    const history = db.messages.slice(-10).map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text
    }));

    const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system(lang) + '\n\n' + ctx }, ...history],
        temperature: 0.4,
        max_completion_tokens: 1500,
        response_format: { type: 'json_object' }
      }),
      signal: AbortSignal.timeout(45000)
    });

    if (!response.ok) {
      throw new Error(`Groq ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }

    const raw = (await response.json()).choices?.[0]?.message?.content;
    if (!raw) throw new Error('Empty AI response.');

    let out;
    try { out = JSON.parse(raw); }
    catch { out = { reply: raw, recommendations: [] }; }

    const reply = out.reply || '…';
    const novas = (Array.isArray(out.recommendations) ? out.recommendations : []).map((item) => ({
      ...item,
      id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
      status: 'pendente'
    }));

    db.recs.push(...novas);
    db.messages.push({ role: 'model', text: reply });
    save(db);

    res.json({ reply, recs: novas });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message || 'AI error.' });
  }
});

// ---------- APROVAR / RECUSAR / ARQUIVAR ----------
app.post('/api/rec/:id', (req, res) => {
  const db = load();
  const rec = db.recs.find((r) => String(r.id) === String(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Not found.' });
  rec.status = req.body.status;
  if (req.body.motivo) rec.motivoRecusa = req.body.motivo;
  save(db);
  res.json(rec);
});

app.listen(3000, () => console.log('TerraCiclo: http://localhost:3000'));
