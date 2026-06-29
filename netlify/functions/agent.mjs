// netlify/functions/agent.mjs
// Assistant + source de donnees du cockpit MARRON.
// Lit Notion (Projets + Taches + Chantiers) et expose :
//   - mode "data" : renvoie tout le dashboard (projets, taches, chantiers) en JSON
//   - mode "chat" : relaie la question a OpenRouter avec le contexte Notion
// La cle OpenRouter et le token Notion restent cote serveur, jamais dans le HTML.
// Netlify Functions v2 (Node 18+). Repond sur /api/agent.

const NOTION_VERSION = "2022-06-28";
const PROJETS_DB   = process.env.PROJETS_DB_ID   || "9642cf381ff243829efada20f671758c";
const TACHES_DB    = process.env.TACHES_DB_ID    || "f430d874e56845fc850450088740b2ee";
const CHANTIERS_DB = process.env.CHANTIERS_DB_ID || "5280326a56724f089c862dc83cc086c4";
const MODEL        = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free";

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

// version qui n'explose pas si la base n'est pas partagee avec la connexion
async function notionQuerySafe(dbId, token) {
  try { return await notionQuery(dbId, token); }
  catch (e) { console.error("notionQuerySafe", dbId, String(e && e.message || e)); return []; }
}

// --- petits lecteurs de proprietes Notion ---
const txt    = (p) => (p?.title || p?.rich_text || []).map((t) => t.plain_text).join("").trim();
const sel    = (p) => p?.select?.name || "";
const dat    = (p) => p?.date?.start || "";
const datEnd = (p) => p?.date?.end || "";
const rel    = (p) => (p?.relation || []).map((r) => r.id);

// --- extrait projets + taches + chantiers en tableaux JSON propres ---
function extractData(projects, tasks, chantiers) {
  const nameById = {};

  const projets = projects.map((pg) => {
    const pr = pg.properties;
    const o = {
      id: pg.id,
      nom: txt(pr["Nom du projet"]),
      entite: sel(pr["Entité"]),
      statut: sel(pr["Statut"]),
      type: sel(pr["Type"]),
      garant: sel(pr["Garant (A)"]),
      priorite: sel(pr["Priorité"]),
      pole: sel(pr["Pôle"]),
      echeance: dat(pr["Échéance"]),
      echeanceEnd: datEnd(pr["Échéance"]),
      chantierIds: rel(pr["Chantier"]),
      notes: txt(pr["Notes"]),
    };
    nameById[pg.id] = o.nom;
    return o;
  });

  const chantierNameById = {};
  const chantiersOut = (chantiers || []).map((cg) => {
    const pr = cg.properties;
    const o = {
      id: cg.id,
      nom: txt(pr["Nom du chantier"]),
      entite: sel(pr["Entité"]),
      pilote: sel(pr["Pilote"]),
      description: txt(pr["Description"]),
      projetIds: rel(pr["Projets"]),
    };
    chantierNameById[cg.id] = o.nom;
    return o;
  });

  // resolution des noms croises
  projets.forEach((p) => {
    p.chantier = (p.chantierIds || []).map((id) => chantierNameById[id]).filter(Boolean);
    delete p.chantierIds;
  });
  chantiersOut.forEach((c) => {
    c.projets = (c.projetIds || []).map((id) => nameById[id]).filter(Boolean);
    delete c.projetIds;
  });

  const taches = tasks.map((tg) => {
    const pr = tg.properties;
    const projet = rel(pr["Projet"]).map((id) => nameById[id]).filter(Boolean).join(", ");
    return {
      id: tg.id,
      tache: txt(pr["Tâche"]),
      statut: sel(pr["Statut"]),
      priorite: sel(pr["Priorité"]),
      resp: sel(pr["Responsable (R)"]),
      echeance: dat(pr["Échéance"]),
      categorie: sel(pr["Catégorie"]),
      projet,
    };
  });

  return { projets, taches, chantiers: chantiersOut };
}

// --- construit un contexte texte compact pour le LLM ---
function contextFromData({ projets, taches, chantiers }) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`Date du jour : ${today}.`, ``, `PROJETS (${projets.length}) :`];
  projets.forEach((p) =>
    lines.push(
      `- ${p.nom} | entité ${p.entite} | statut ${p.statut} | garant ${p.garant} | priorité ${p.priorite} | pôle ${p.pole} | chantier ${(p.chantier || []).join(", ") || "—"} | échéance ${p.echeance || "non définie"}${p.notes ? ` | note: ${p.notes}` : ""}`
    )
  );
  lines.push(``, `TÂCHES (${taches.length}) :`);
  taches.forEach((t) =>
    lines.push(
      `- ${t.tache} | projet ${t.projet || "—"} | statut ${t.statut} | responsable ${t.resp} | priorité ${t.priorite} | échéance ${t.echeance || "non définie"}`
    )
  );
  if (chantiers && chantiers.length) {
    lines.push(``, `CHANTIERS (${chantiers.length}) :`);
    chantiers.forEach((c) =>
      lines.push(`- ${c.nom} | entité ${c.entite} | pilote ${c.pilote || "—"} | projets ${(c.projets || []).join(", ") || "—"}`)
    );
  }
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
  if (req.method !== "POST") return json({ error: "POST uniquement" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const mode = body.mode || "chat";

    const NOTION = process.env.NOTION_TOKEN;
    if (!NOTION) return json({ error: "NOTION_TOKEN manquant cote serveur" }, 500);

    // 1. lire Notion (toujours). Chantiers en mode tolerant : si la base n'est pas
    // encore partagee avec la connexion, on renvoie [] au lieu de tout casser.
    const [projects, tasks, chantiers] = await Promise.all([
      notionQuery(PROJETS_DB, NOTION),
      notionQuery(TACHES_DB, NOTION),
      notionQuerySafe(CHANTIERS_DB, NOTION),
    ]);
    const data = extractData(projects, tasks, chantiers);

    // 2a. mode lecture brute : l'app remplit toutes ses pages avec ca
    if (mode === "data") return json(data);

    // 2b. mode chat : on demande au LLM
    const { question, history } = body;
    if (!question) return json({ error: "question manquante" }, 400);

    const OPENROUTER = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER) return json({ error: "OPENROUTER_API_KEY manquant cote serveur" }, 500);

    const context = contextFromData(data);
    const messages = [
      { role: "system", content: `${SYSTEM}\n\n=== DONNEES ===\n${context}` },
      ...(Array.isArray(history) ? history.slice(-6) : []),
      { role: "user", content: question },
    ];

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
    return json({ error: String((e && e.message) || e) }, 500);
  }
};

export const config = { path: "/api/agent" };
