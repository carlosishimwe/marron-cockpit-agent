# MARRON Cockpit Agent — guide agents

## Projet

Dashboard interne MARRON / REROOM : cockpit de pilotage (projets, tâches, chantiers, équipe) alimenté par Notion, avec assistant IA via OpenRouter.

## Stack

- **Frontend** : SPA vanilla (`index.html`, CSS + JS inline, pas de bundler)
- **Backend** : Netlify Function `netlify/functions/agent.mjs` (Node 18+, esbuild)
- **Données** : API Notion (Projets, Tâches, Chantiers)
- **IA** : OpenRouter (`POST /api/agent`, modes `data` et `chat`)
- **Deploy** : Netlify (`publish = "."`, secrets dans les variables d'environnement)

## Règles de code (inférées du repo)

- Pas de framework front : garder HTML/CSS/JS inline dans `index.html` sauf demande contraire.
- Secrets jamais dans le code : `NOTION_TOKEN`, `OPENROUTER_API_KEY` côté Netlify uniquement (voir `.env.example`).
- Français dans l'UI et les réponses agent ; tutoiement pour le chat.
- Fallback gracieux : si `/api/agent` échoue, le dashboard garde les données démo embarquées.
- Fonction agent : pagination Notion, CORS ouvert, cascade de modèles OpenRouter en secours.
- Pas de build step applicatif : le site est servi tel quel depuis la racine.

## Definition of done (all agents, all sprints)

Before reporting any task as done:

1. The build passes clean: `npm run build`
2. `npm run test:e2e` passes (Playwright smoke tests)
3. Open the app in the browser tool, walk through the affected views, screenshot them, and fix any visual breakage before handing back

Never report done on a red build or a failing test.
