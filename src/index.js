#!/usr/bin/env node
/**
 * Serveur MCP de GPSEM.
 *
 * Les outils sont générés au démarrage depuis la spécification OpenAPI de l'API externe GPSEM
 * (GET {GPSEM_API_URL}/openapi.json) : chaque opération devient un outil, nommé par son operationId.
 * Une nouvelle route ajoutée à l'API apparaît donc dans le MCP sans nouvelle version de ce paquet.
 *
 * Variables d'environnement :
 *   GPSEM_API_TOKEN  (obligatoire) token « gpsem_… » créé dans GPSEM, Entreprise → API GPSEM
 *   GPSEM_API_URL    (facultatif)  défaut https://app.gpsem.io/api/v1/external
 *   GPSEM_SITE_ID    (facultatif)  site par défaut (ID encodé) quand l'outil attend siteId
 *   GPSEM_MAX_CHARS  (facultatif)  taille maximale d'une réponse renvoyée à l'assistant (défaut 60000)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const API_URL = (process.env.GPSEM_API_URL || 'https://app.gpsem.io/api/v1/external').replace(/\/+$/, '');
const TOKEN = process.env.GPSEM_API_TOKEN || '';
const SITE_PAR_DEFAUT = process.env.GPSEM_SITE_ID || '';
const MAX_CHARS = Number(process.env.GPSEM_MAX_CHARS) || 60000;
const METHODES = ['get', 'post', 'put', 'patch', 'delete'];

const INSTRUCTIONS = `GPSEM est une plateforme SEO. Ces outils lisent et modifient les données d'un compte GPSEM (entreprise, sites, pages, audits).

Catalogue des rapports : listReportsForSite (ou listReports) donne tous les rapports disponibles — chaque section / question de l'audit complet,
chaque problème Screaming Frog relevé, NavRank / ClickRank, Opquast, sources de données — avec l'outil et les arguments à utiliser, et ce qui est
disponible pour le site. Le résumé ci-dessous (fin des consignes) liste les rapports ; le catalogue complet est aussi la ressource gpsem://rapports.

Démarrage : getMe (entreprise du token, quota de sites), puis listSites avec l'id de l'entreprise pour obtenir les siteId (identifiants encodés, ex. « Wl2Ljya96q »).
Les IDs de page, catégorie (category_id) et archive (cpt_id) sont numériques ; ils viennent de listPages, listCategories et listArchives.

Lire beaucoup de données par étapes : les réponses volumineuses sont résumées ou paginées. Commencer par la vue d'ensemble puis descendre :
- audit : listAuditSections → getAuditSection (résumé, constats, actions priorisées et data_index) → getAuditSection avec data=… ou bloc=… (limit, page) ;
- rapports : listAuditReports → getAuditReport (scores, synthèse, plan d'action) → getAuditReport avec section=… ;
- cartographie sémantique : getSemanticMap (résumé) → cluster=…, q=…, page_id=…, sort/order, limit/page ;
- listes (pages, mots-clés, contenus, historique) : limit et page, meta.total donne le volume.

Données de trafic en direct, avec les connexions déjà faites dans GPSEM (rien à reconnecter) : querySearchConsole (dimensions query, page, date,
device, country ; search_type=discover pour Discover, qui n'accepte que page, date et country), queryAnalytics (rapport GA4 libre : dimensions et
métriques GA4), queryBing, queryMerchant, queryYoutube. Une erreur source_not_connected signifie que la source n'est pas connectée pour ce site :
le signaler à l'utilisateur (connexion à faire une fois dans GPSEM) plutôt que d'insister.

Justifier les recommandations : searchKnowledge cherche dans la documentation Google Search Central (en français) ; citer l'URL de la source.
Les actions d'audit et les rapports de problèmes Screaming Frog portent déjà leurs references.

Tracer chaque modification dans l'historique (addSiteHistorique) : c'est ce qui permet à GPSEM de mesurer l'effet des changements sur le trafic.
Lire d'abord getHistoriqueCodes et choisir le code le plus précis de la cible (100 site, 300 page, 310 catégorie, 320 archive) ; sinon le code générique
(100-09-001, 300-09-001, 310-09-001, 320-09-001) avec une description claire et l'avant / après dans details. updatePage et createPage écrivent leur historique eux-mêmes.

Audit technique à jour : launchScreamingFrogCrawl lance un crawl (de quelques minutes à quelques heures) ; suivre listScreamingFrogCrawls jusqu'au statut
« importe », puis lire getScreamingFrogDashboard, listScreamingFrogActions, getScreamingFrogIssue. createAuditReport régénère ensuite l'audit complet.

Audit Opquast (qualité web, 240 règles) : createOpquastAudit, puis getOpquastAudit (catégories). Marquer d'abord les catégories hors périmètre
(updateOpquastCategory applicable=false, ex. E-commerce ou Newsletter si le site n'en a pas). Pour chaque catégorie restante : getOpquastAudit avec
category_id, évaluer chaque règle sur des preuves (crawl Screaming Frog : getScreamingFrogDashboard, getScreamingFrogIssue, getScreamingFrogPage ;
pages : getPage avec content=1, listPages ; mentions légales : getLegalNotice ; paramètres du site) et répondre par lots avec answerOpquastRules :
result conforme / non_conforme et un commentaire qui dit ce qui a été vérifié (pages, source) et, si non conforme, la correction attendue.
Une règle qui ne peut pas être vérifiée avec les données disponibles reste conforme par défaut mais reçoit un commentaire « à vérifier manuellement ».
Terminer chaque catégorie par une synthèse (updateOpquastCategory comment). Toutes les réponses restent modifiables dans GPSEM (lien renvoyé).

Achat de backlinks (MyBack.link) : lire d'abord getMybacklinkStatus (achat autorisé, plafonds, dépense du mois, crédit, coût des options, ancres déjà utilisées),
choisir les pages cibles à partir des données GPSEM (pages performantes fragilisées, mots-clés en page 2, backlinks perdus), puis présenter la commande
(URL, mots-clés, nombre d'articles, options) et n'appeler orderBacklinks qu'après un accord explicite : c'est un achat réel.

Actions à effet réel (demander confirmation à l'utilisateur avant) : orderBacklinks (achat), launchScreamingFrogCrawl (charge le serveur de crawl), createSite (consomme le quota), createPage / updatePage avec push_to_cms, pushPageToCms, syncSite,
createContent / writeContentIdea (rédaction automatique), createAuditReport, updateCompanyInfo, updateSiteSettings, updateLegalNotice.
Les traitements longs renvoient un task_id à suivre avec getTask, ou un statut pending à relire.`;

/** Appel HTTP à l'API GPSEM ; renvoie { status, body } avec body décodé si JSON. */
async function appeler(methode, chemin, { query = {}, body } = {}) {
  const url = new URL(API_URL + chemin);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const reponse = await fetch(url, {
    method: methode.toUpperCase(),
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      'User-Agent': `gpsem-mcp/${VERSION}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const texte = await reponse.text();
  let decode = texte;
  try { decode = JSON.parse(texte); } catch { /* réponse non JSON : texte brut */ }
  return { status: reponse.status, body: decode };
}

/** Résout un $ref local (#/components/...) de la spécification. */
function resoudre(spec, objet) {
  let o = objet;
  let garde = 0;
  while (o && o.$ref && garde++ < 10) {
    o = o.$ref.replace(/^#\//, '').split('/').reduce((acc, cle) => (acc ? acc[cle] : undefined), spec);
  }
  return o || {};
}

/** Schéma OpenAPI 3.0 → JSON Schema accepté par les clients MCP (nullable, exemples retirés). */
function schemaJson(spec, schema) {
  const s = resoudre(spec, schema);
  const r = {};
  for (const [k, v] of Object.entries(s)) {
    if (['example', 'nullable', 'xml', 'externalDocs'].includes(k)) continue;
    if (k === 'properties') r.properties = Object.fromEntries(Object.entries(v).map(([n, p]) => [n, schemaJson(spec, p)]));
    else if (k === 'items') r.items = schemaJson(spec, v);
    else if (k === 'allOf' || k === 'oneOf' || k === 'anyOf') r[k] = v.map((x) => schemaJson(spec, x));
    else r[k] = v;
  }
  if (s.nullable && r.type) r.type = [].concat(r.type, 'null');
  return r;
}

/** Construit la liste des outils à partir de la spécification OpenAPI. */
function outilsDepuisSpec(spec) {
  const outils = [];
  for (const [chemin, operations] of Object.entries(spec.paths || {})) {
    for (const methode of METHODES) {
      const op = operations[methode];
      if (!op || !op.operationId) continue;
      const proprietes = {};
      const requis = [];
      const parametres = [];
      for (const brut of op.parameters || []) {
        const p = resoudre(spec, brut);
        if (!['path', 'query'].includes(p.in)) continue;
        parametres.push({ nom: p.name, dans: p.in });
        proprietes[p.name] = { ...schemaJson(spec, p.schema || { type: 'string' }), description: p.description || undefined };
        if (p.name === 'siteId' && SITE_PAR_DEFAUT) {
          proprietes[p.name].description = `${p.description || 'ID encodé du site'} (défaut : ${SITE_PAR_DEFAUT})`;
        } else if (p.required) {
          requis.push(p.name);
        }
      }
      // Corps JSON : ses propriétés sont mises à plat à côté des paramètres ; un objet libre passe par « body »
      let corps = null;
      const schemaCorps = op.requestBody?.content?.['application/json']?.schema;
      if (schemaCorps) {
        const s = schemaJson(spec, schemaCorps);
        if (s.properties && Object.keys(s.properties).length) {
          corps = { mode: 'plat', champs: Object.keys(s.properties) };
          for (const [nom, def] of Object.entries(s.properties)) {
            if (proprietes[nom]) continue;
            proprietes[nom] = def;
          }
          for (const nom of s.required || []) if (!requis.includes(nom)) requis.push(nom);
        } else {
          corps = { mode: 'objet' };
          proprietes.body = { type: 'object', description: s.description || 'Corps JSON de la requête', additionalProperties: true };
          if (op.requestBody.required) requis.push('body');
        }
      }
      const lecture = methode === 'get';
      outils.push({
        definition: {
          name: op.operationId,
          title: op.summary,
          description: [op.summary, op.description, `(${methode.toUpperCase()} ${chemin})`].filter(Boolean).join(' — '),
          inputSchema: { type: 'object', properties: proprietes, ...(requis.length ? { required: requis } : {}) },
          annotations: {
            title: op.summary,
            readOnlyHint: lecture,
            destructiveHint: false,
            idempotentHint: lecture || methode === 'patch' || methode === 'put',
            openWorldHint: !lecture,
          },
        },
        methode,
        chemin,
        parametres,
        corps,
      });
    }
  }
  return outils;
}

/** Exécute un outil : place chaque argument dans le chemin, la requête ou le corps. */
async function executer(outil, args = {}) {
  let chemin = outil.chemin;
  const query = {};
  const utilises = new Set();
  for (const { nom, dans } of outil.parametres) {
    let valeur = args[nom];
    if ((valeur === undefined || valeur === '') && nom === 'siteId') valeur = SITE_PAR_DEFAUT || undefined;
    utilises.add(nom);
    if (dans === 'path') {
      if (valeur === undefined || valeur === '') throw new Error(`Paramètre « ${nom} » obligatoire.`);
      chemin = chemin.replace(`{${nom}}`, encodeURIComponent(String(valeur)));
    } else if (valeur !== undefined) {
      query[nom] = valeur;
    }
  }
  let body;
  if (outil.corps?.mode === 'objet') {
    body = args.body ?? {};
  } else if (outil.corps?.mode === 'plat') {
    body = {};
    for (const [k, v] of Object.entries(args)) if (!utilises.has(k) && v !== undefined) body[k] = v;
    if (args.source === undefined && outil.chemin.endsWith('/historique')) body.source = 'mcp';
  }
  return appeler(outil.methode, chemin, { query, body });
}

/** Mise en forme d'une réponse pour l'assistant, tronquée au-delà de MAX_CHARS. */
function texteReponse({ status, body }) {
  let texte = typeof body === 'string' ? body : JSON.stringify(body, null, 1);
  if (texte.length > MAX_CHARS) {
    texte = texte.slice(0, MAX_CHARS)
      + `\n\n[Réponse tronquée : ${texte.length} caractères. Affiner la demande : limit / page, section=…, bloc=…, data=…, filtres de recherche.]`;
  }
  return status >= 400 ? `Erreur HTTP ${status}\n${texte}` : texte;
}

/**
 * Résumé du catalogue des rapports, ajouté aux consignes envoyées au client à la connexion : l'assistant sait d'emblée
 * quels rapports existent (dont chaque section / question de l'audit complet) et quel outil appeler.
 */
async function resumeRapports() {
  try {
    const r = await appeler('get', SITE_PAR_DEFAUT ? `/sites/${encodeURIComponent(SITE_PAR_DEFAUT)}/rapports` : '/rapports');
    if (r.status !== 200 || typeof r.body !== 'object') return '';
    const d = r.body.data || {};
    const lignes = ['\n\nRAPPORTS DISPONIBLES' + (d.site ? ` pour ${d.site.name} (siteId ${d.site.id})` : '') + ' — outil(arguments) :'];
    for (const g of d.groups || []) {
      lignes.push(`\n${g.group}`);
      let chapitre = null;
      for (const x of g.reports || []) {
        if (x.chapter && x.chapter !== chapitre) { chapitre = x.chapter; lignes.push(`  ${chapitre}`); }
        const args = Object.entries(x.arguments || {}).filter(([k]) => k !== 'siteId').map(([k, v]) => `${k}=${v}`).join(', ');
        const dispo = x.available === false ? ' [indisponible pour ce site]' : '';
        lignes.push(`  - ${x.title} → ${x.tool}(${args})${dispo}`);
      }
    }
    const sf = d.screaming_frog_issues?.found;
    if (sf && sf.length) {
      lignes.push(`\nProblèmes Screaming Frog relevés au dernier crawl (getScreamingFrogIssue code=…) : `
        + sf.slice(0, 40).map((p) => `${p.code} (${p.urls} URL, P${p.priority})`).join(', ') + (sf.length > 40 ? `… et ${sf.length - 40} autres` : ''));
    }
    return lignes.join('\n');
  } catch {
    return '';
  }
}

let outilsCache = null;
async function outils() {
  if (outilsCache) return outilsCache;
  const r = await appeler('get', '/openapi.json');
  if (r.status !== 200 || typeof r.body !== 'object') {
    throw new Error(`Spécification OpenAPI inaccessible (${API_URL}/openapi.json, HTTP ${r.status}).`);
  }
  outilsCache = outilsDepuisSpec(r.body);
  return outilsCache;
}

async function main() {
  if (process.argv.includes('--list-tools')) {
    for (const o of await outils()) console.log(`${o.definition.name.padEnd(30)} ${o.methode.toUpperCase().padEnd(6)} ${o.chemin}`);
    return;
  }
  if (!TOKEN) {
    console.error('GPSEM_API_TOKEN manquant : créez un token dans GPSEM (Entreprise → API GPSEM) et passez-le en variable d\'environnement.');
    process.exit(1);
  }

  const server = new Server({ name: 'gpsem', version: VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS + (await resumeRapports()) });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await outils()).map((o) => o.definition) }));

  // Catalogue des rapports en ressources MCP : général, et par site si GPSEM_SITE_ID est défini
  const ressources = [{ uri: 'gpsem://rapports', chemin: '/rapports', name: 'Catalogue des rapports GPSEM',
    description: 'Tous les rapports lisibles : sections de l\'audit complet, problèmes Screaming Frog, NavRank, Opquast, sources, analyses, avec l\'outil à appeler.' }];
  if (SITE_PAR_DEFAUT) {
    ressources.push({ uri: `gpsem://sites/${SITE_PAR_DEFAUT}/rapports`, chemin: `/sites/${encodeURIComponent(SITE_PAR_DEFAUT)}/rapports`,
      name: 'Rapports disponibles pour le site par défaut', description: 'Disponibilité des sources et rapports, problèmes Screaming Frog relevés.' });
  }
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: ressources.map(({ uri, name, description }) => ({ uri, name, description, mimeType: 'application/json' })),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (requete) => {
    const uri = requete.params.uri;
    const connue = ressources.find((r) => r.uri === uri);
    const site = uri.match(/^gpsem:\/\/sites\/([^/]+)\/rapports$/);
    const chemin = connue ? connue.chemin : site ? `/sites/${encodeURIComponent(site[1])}/rapports` : null;
    if (!chemin) throw new Error(`Ressource inconnue : ${uri}`);
    const r = await appeler('get', chemin);
    return { contents: [{ uri, mimeType: 'application/json', text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 1) }] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (requete) => {
    const outil = (await outils()).find((o) => o.definition.name === requete.params.name);
    if (!outil) {
      return { isError: true, content: [{ type: 'text', text: `Outil inconnu : ${requete.params.name}` }] };
    }
    try {
      const r = await executer(outil, requete.params.arguments || {});
      return { isError: r.status >= 400, content: [{ type: 'text', text: texteReponse(r) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Échec de l'appel à GPSEM : ${e.message}` }] };
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
