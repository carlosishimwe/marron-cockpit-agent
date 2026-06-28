// netlify/functions/agent.mjs
// Assistant de pilotage MARRON.
// Lit les bases Notion (Projets + Tâches) puis relaie la question à OpenRouter.
// La cle OpenRouter et le token Notion restent cote serveur, jamais dans le HTML.
// Netlify Functions v2 (Node 18+). Repond sur /api/agent.

const NOTION_VERSION = "2022-06-28";
const PROJETS_DB = process.env.PROJETS_DB_ID || "9642cf381ff243829efada20f671758c";
const TACHES_DB  = process.env.TACHES_DB_ID  || "f430d874e56845fc850450088740b2ee";
const MODEL      = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const notionHeaders = (token) => ({
  "Authorization": `Bearer ${token}`,
  "Notion-Version": NOTION_VERSION,
  "Content-Type": "application/json",
});

// --- lecture d'une base Notion, avec pagination ---
async function notionQuery(dbId, token) {
  let results = [], cursor;
  do {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: notionHeaders(token),
      body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
    });
    if (!r.ok) throw new Error(`Notion ${dbId} ${r.status}: ${await r.text()}`);
    const j = await r.json();
    results = results.concat(j.results || []);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return results;
}

// --- petits lecteurs de proprietes Notion ---
const txt = (p) => (p?.title || p?.rich_text || []).map((t) => t.plain_text).join("").trim();
const sel = (p) => p?.select?.name || "";
const dat = (p) => p?.date?.start || "";
const rel = (p) => (p?.relation || []).map((r) => r.id);

// --- construit un contexte texte compact pour le LLM ---
function buildContext(projects, tasks) {
  const nameById = {};
  const P = projects.map((pg) => {
    const pr = pg.properties;
    const o = {
      id: pg.id,
      nom: txt(pr["Nom du projet"]),
      entite: sel(pr["Entité"]),
      statut: sel(pr["Statut"]),
      garant: sel(pr["Garant (A)"]),
      priorite: sel(pr["Priorité"]),
      pole: sel(pr["Pôle"]),
      echeance: dat(pr["Échéance"]),
      notes: txt(pr["Notes"]),
    };
    nameById[pg.id] = o.nom;
    return o;
  });

  const T = tasks.map((tg) => {
    const pr = tg.properties;
    const projet = rel(pr["Projet"]).map((id) => nameById[id]).filter(Boolean).join(", ");
    return {
      tache: txt(pr["Tâche"]),
      statut: sel(pr["Statut"]),
      priorite: sel(pr["Priorité"]),
      resp: sel(pr["Responsable (R)"]),
      echeance: dat(pr["Échéance"]),
      projet,
    };
  });

  const today = new Date().toISOString().slice(0, 10);
  const lines = [`Date du jour : ${today}.`, ``, `PROJETS (${P.length}) :`];
  P.forEach((p) =>
    lines.push(
      `- ${p.nom} | entité ${p.entite} | statut ${p.statut} | garant ${p.garant} | priorité ${p.priorite} | pôle ${p.pole} | échéance ${p.echeance || "non définie"}${p.notes ? ` | note: ${p.notes}` : ""}`
    )
  );
  lines.push(``, `TÂCHES (${T.length}) :`);
  T.forEach((t) =>
    lines.push(
      `- ${t.tache} | projet ${t.projet || "—"} | statut ${t.statut} | responsable ${t.resp} | priorité ${t.priorite} | échéance ${t.echeance || "non définie"}`
    )
  );
  return lines.join("\n");
}

const SYSTEM = `Tu es l'assistant de pilotage interne de MARRON et REROOM. Tu parles a Carlos et a l'equipe.
Regles :
- Reponds en francais, tutoiement, ton direct et chaleureux, concis.
- N'utilise jamais de tirets longs ni courts dans tes phrases, mets des virgules ou des points a la place.
- Reponds UNIQUEMENT a partir des donnees fournies plus bas. Si l'info n'y est pas, dis-le simplement.
- Une tache est en retard si son echeance est avant la date du jour et que son statut n'est pas Fait.
- Quand tu listes, va a l'essentiel : nom, projet, responsable, echeance.`;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });

  // GET = diagnostic (ne revele jamais les secrets)
  if (req.method === "GET") {
    return json({
      ok: true,
      env: {
        NOTION_TOKEN: process.env.NOTION_TOKEN ? "defini (longueur " + process.env.NOTION_TOKEN.length + ")" : "MANQUANT",
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ? "defini (longueur " + process.env.OPENROUTER_API_KEY.length + ")" : "MANQUANT",
        PROJETS_DB_ID: PROJETS_DB,
        TACHES_DB_ID: TACHES_DB,
        MODEL: MODEL,
      }
    });
  }

  if (req.method !== "POST") return json({ error: "POST uniquement" }, 405);

  try {
    const { question, history } = await req.json();
    if (!question) return json({ error: "question manquante" }, 400);

    const NOTION = process.env.NOTION_TOKEN;
    const OPENROUTER = process.env.OPENROUTER_API_KEY;
    if (!NOTION || !OPENROUTER) return json({ error: "NOTION_TOKEN ou OPENROUTER_API_KEY manquant cote serveur" }, 500);

    // 1. lire Notion
    const [projects, tasks] = await Promise.all([
      notionQuery(PROJETS_DB, NOTION),
      notionQuery(TACHES_DB, NOTION),
    ]);
    const context = buildContext(projects, tasks);

    // 2. composer les messages
    const messages = [
      { role: "system", content: `${SYSTEM}\n\n=== DONNEES ===\n${context}` },
      ...(Array.isArray(history) ? history.slice(-6) : []),
      { role: "user", content: question },
    ];

    // 3. appeler OpenRouter
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://marron.earth",
        "X-Title": "MARRON Cockpit",
      },
      body: JSON.stringify({ model: MODEL, messages, temperature: 0.3, max_tokens: 600 }),
    });
    if (!r.ok) return json({ error: `OpenRouter ${r.status}: ${await r.text()}` }, 502);

    const j = await r.json();
    const answer = j.choices?.[0]?.message?.content?.trim() || "Pas de reponse.";
    return json({ answer });
  } catch (e) {
    return json({ error: String((e && e.message) || e), stack: (e && e.stack) ? String(e.stack).split("\n").slice(0, 3).join(" | ") : undefined }, 500);
  }
};

export const config = { path: "/api/agent" };