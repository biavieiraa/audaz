import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();

app.use(express.json({ limit: "2mb" }));

// ---------- CONFIGURAÇÕES ----------

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

const groqApiKey = process.env.GROQ_API_KEY;
const groqModel =
  process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

// Nome da tabela no Supabase (confira no Table Editor).
const TABLE = "audaz_state";

const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey)
    : null;

const initialState = {
  profile: null,
  nasa: null,
  nasaErro: null,
  messages: [],
  recs: []
};

// ---------- IDENTIFICAÇÃO DO USUÁRIO ----------

function getUserId(req) {
  // O Node converte os nomes dos cabeçalhos para minúsculas.
  const id = req.headers["x-cultivai-user"];

  if (
    typeof id !== "string" ||
    !/^[a-zA-Z0-9-]{10,100}$/.test(id)
  ) {
    return null;
  }

  return id;
}

// ---------- BANCO DE DADOS SUPABASE ----------

async function load(userId) {
  if (!supabase) {
    throw new Error("Supabase não configurado no servidor.");
  }

  const { data, error } = await supabase
    .from(TABLE)
    .select("state")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;

  return {
    ...initialState,
    ...(data?.state || {})
  };
}

async function save(userId, db) {
  const { error } = await supabase
    .from(TABLE)
    .upsert(
      {
        user_id: userId,
        state: db,
        updated_at: new Date().toISOString()
      },
      { onConflict: "user_id" }
    );

  if (error) throw error;
}

// ---------- CONTROLE DAS ROTAS ----------

function withUser(handler) {
  return async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({
          error: "Supabase não configurado."
        });
      }

      const userId = getUserId(req);

      if (!userId) {
        return res.status(400).json({
          error: "Identificador do usuário ausente ou inválido."
        });
      }

      await handler(req, res, userId);
    } catch (error) {
      console.error("API error:", error);

      if (!res.headersSent) {
        res.status(500).json({
          error: error.message || "Erro interno no servidor."
        });
      }
    }
  };
}

// ---------- NASA POWER ----------

const fmt = (date) =>
  date.toISOString().slice(0, 10).replace(/-/g, "");

async function getNasa(lat, lon) {
  if (
    !Number.isFinite(Number(lat)) ||
    !Number.isFinite(Number(lon)) ||
    lat === "" ||
    lon === ""
  ) {
    throw new Error("Latitude/longitude missing.");
  }

  const end = new Date(Date.now() - 3 * 864e5);
  const start = new Date(end.getTime() - 59 * 864e5);

  const url = new URL(
    "https://power.larc.nasa.gov/api/temporal/daily/point"
  );

  url.search = new URLSearchParams({
    parameters: "T2M,PRECTOTCORR,ALLSKY_SFC_SW_DWN",
    community: "AG",
    longitude: String(lon),
    latitude: String(lat),
    start: fmt(start),
    end: fmt(end),
    format: "JSON"
  }).toString();

  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error("NASA POWER " + response.status);
  }

  const data = await response.json();
  const p = data.properties.parameter;

  const valid = (value) =>
    value !== undefined &&
    value !== null &&
    value > -900
      ? value
      : null;

  const days = Object.keys(p.T2M).map((date) => ({
    d: date,
    t: valid(p.T2M[date]),
    p: valid(p.PRECTOTCORR[date]),
    s: valid(p.ALLSKY_SFC_SW_DWN[date])
  }));

  const avg = (key) => {
    const values = days
      .map((day) => day[key])
      .filter((value) => value !== null);

    return values.length
      ? +(
          values.reduce((a, b) => a + b, 0) /
          values.length
        ).toFixed(1)
      : null;
  };

  return {
    fonte: "NASA POWER (regional estimate)",
    periodo: days.length
      ? `${days[0].d}-${days[days.length - 1].d}`
      : "n/a",
    tempMedia: avg("t"),
    chuvaTotalMm: +days
      .reduce((sum, day) => sum + (day.p || 0), 0)
      .toFixed(1),
    radiacaoMedia: avg("s"),
    days
  };
}

// ---------- GEOCODIFICAÇÃO ----------

app.get("/api/geocode", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    const lang = ["pt", "en", "es"].includes(req.query.lang)
      ? req.query.lang
      : "en";

    if (!q) {
      return res.status(400).json({ error: "empty" });
    }

    const url = new URL(
      "https://geocoding-api.open-meteo.com/v1/search"
    );

    url.search = new URLSearchParams({
      name: q,
      count: "1",
      language: lang
    }).toString();

    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error("Geocoding service error.");
    }

    const data = await response.json();
    const g = data.results?.[0];

    if (!g) {
      return res.status(404).json({ error: "notfound" });
    }

    res.json({
      cidade: g.name,
      uf: g.admin1 || "",
      lat: g.latitude,
      lon: g.longitude
    });
  } catch (error) {
    console.error("Geocode error:", error);

    res.status(500).json({
      error: error.message
    });
  }
});

// ---------- ESTADO DO USUÁRIO ----------

app.get(
  "/api/state",
  withUser(async (req, res, userId) => {
    const db = await load(userId);
    res.json(db);
  })
);

// ---------- CADASTRO DO AGRICULTOR ----------

app.post(
  "/api/profile",
  withUser(async (req, res, userId) => {
    const db = await load(userId);

    db.profile = req.body;
    db.nasa = null;
    db.nasaErro = null;

    try {
      db.nasa = await getNasa(
        req.body.lat,
        req.body.lon
      );
    } catch (error) {
      db.nasaErro = error.message;
    }

    await save(userId, db);

    res.json({
      ok: true,
      nasa: db.nasa,
      nasaErro: db.nasaErro
    });
  })
);

// ---------- INSTRUÇÕES DA IA ----------

const LANGS = {
  pt: "português do Brasil",
  en: "English",
  es: "español"
};

const system = (lang) => `
Você é o CultivAI, assistente agrícola para agricultores familiares.
Ajude o agricultor a entender seu solo, suas culturas, o clima e o manejo.

IDIOMA: responda SEMPRE em ${LANGS[lang]} (campo reply e todos os textos das recomendações), mesmo que o histórico esteja em outro idioma. As chaves do JSON ficam como estão abaixo.

COMUNICAÇÃO:
- Linguagem simples, acolhedora, frases curtas e práticas.
- Responda perguntas livres, considere o histórico, não repita informações.
- Fora do tema agrícola, responda com educação e volte ao objetivo do CultivAI.

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

// ---------- CHAT COM GROQ ----------

app.post(
  "/api/chat",
  withUser(async (req, res, userId) => {
    const db = await load(userId);

    const message = req.body.message?.trim();

    const lang = LANGS[req.body.lang]
      ? req.body.lang
      : "en";

    if (!message) {
      return res.status(400).json({
        error: "Empty message."
      });
    }

    if (!groqApiKey) {
      return res.status(500).json({
        error: "GROQ_API_KEY missing."
      });
    }

    if (!db.profile) {
      return res.status(400).json({
        error: "Complete the registration first."
      });
    }

    db.messages.push({
      role: "user",
      text: message
    });

    const decisoes = db.recs
      .filter((r) => r.status !== "pendente")
      .map(
        (r) =>
          `${r.titulo}: ${r.status}${
            r.motivoRecusa
              ? " (" + r.motivoRecusa + ")"
              : ""
          }`
      );

    const ctx = `
CADASTRO DO AGRICULTOR:
${JSON.stringify(db.profile)}

DADOS DA NASA POWER (últimos 60 dias, estimativa regional):
${
  db.nasa
    ? JSON.stringify({ ...db.nasa, days: undefined })
    : "Indisponíveis"
}

DECISÕES ANTERIORES:
${decisoes.join("; ") || "Nenhuma"}
`;

    const history = db.messages.slice(-10).map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.text
    }));

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${groqApiKey}`
        },
        body: JSON.stringify({
          model: groqModel,
          messages: [
            {
              role: "system",
              content: system(lang) + "\n\n" + ctx
            },
            ...history
          ],
          temperature: 0.4,
          max_completion_tokens: 1500,
          response_format: {
            type: "json_object"
          }
        }),
        signal: AbortSignal.timeout(45000)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      throw new Error(
        `Groq ${response.status}: ${errorText.slice(0, 400)}`
      );
    }

    const raw = (
      await response.json()
    ).choices?.[0]?.message?.content;

    if (!raw) {
      throw new Error("Empty AI response.");
    }

    let out;

    try {
      out = JSON.parse(raw);
    } catch {
      out = {
        reply: raw,
        recommendations: []
      };
    }

    const reply = out.reply || "…";

    const novas = (
      Array.isArray(out.recommendations)
        ? out.recommendations
        : []
    ).map((item) => ({
      ...item,
      id:
        Date.now().toString() +
        Math.random().toString(36).slice(2, 7),
      status: "pendente"
    }));

    db.recs.push(...novas);

    db.messages.push({
      role: "model",
      text: reply
    });

    await save(userId, db);

    res.json({
      reply,
      recs: novas
    });
  })
);

// ---------- APROVAR / RECUSAR / ARQUIVAR ----------

app.post(
  "/api/rec/:id",
  withUser(async (req, res, userId) => {
    const db = await load(userId);

    const rec = db.recs.find(
      (r) => String(r.id) === String(req.params.id)
    );

    if (!rec) {
      return res.status(404).json({
        error: "Not found."
      });
    }

    rec.status = req.body.status;

    if (req.body.motivo) {
      rec.motivoRecusa = req.body.motivo;
    }

    await save(userId, db);

    res.json(rec);
  })
);

// ---------- EXPORTAÇÃO ----------

export default app;
