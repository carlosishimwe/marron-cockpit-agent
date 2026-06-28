# MARRON Cockpit, backend agent

Fonction Netlify qui lit les bases Notion Projets et Taches puis repond aux questions via OpenRouter.

## Variables d'environnement (dans Netlify, jamais dans le code)
- NOTION_TOKEN : token d'une connexion Notion interne, commence par ntn_
- OPENROUTER_API_KEY : cle OpenRouter, commence par sk-or-
- OPENROUTER_MODEL : optionnel, modele gratuit par defaut

## Endpoint
POST /api/agent, body {"question":"...", "history":[...]}, reponse {"answer":"..."}

## Prerequis Notion
Partager les deux bases (Projets, Taches) avec la connexion, sinon l'API renvoie 404.