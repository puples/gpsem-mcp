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
 *   GPSEM_EXPORT_DIR (facultatif)  dossier où les outils de lecture peuvent enregistrer leur réponse complète
 *                                  (arguments enregistrer_sous et toutes_les_pages) ; absent : pas d'export en fichier
 *   GPSEM_EXPORT_MAX_PAGES (facultatif) nombre maximal de pages enchaînées par toutes_les_pages (défaut 200)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const API_URL = (process.env.GPSEM_API_URL || 'https://app.gpsem.io/api/v1/external').replace(/\/+$/, '');
const TOKEN = process.env.GPSEM_API_TOKEN || '';
const SITE_PAR_DEFAUT = process.env.GPSEM_SITE_ID || '';
const MAX_CHARS = Number(process.env.GPSEM_MAX_CHARS) || 60000;
const EXPORT_DIR = process.env.GPSEM_EXPORT_DIR ? path.resolve(process.env.GPSEM_EXPORT_DIR) : '';
const EXPORT_MAX_PAGES = Math.max(1, Math.floor(Number(process.env.GPSEM_EXPORT_MAX_PAGES)) || 200);
const EXPORT_EXTENSIONS = ['.json', '.jsonl', '.csv'];
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
${EXPORT_DIR ? `
Export en fichier : pour un export ou toute liste de plus de quelques centaines de lignes, utiliser enregistrer_sous (+ toutes_les_pages) plutôt que
de lire les tranches une à une ; travailler ensuite sur le fichier. enregistrer_sous = nom de fichier relatif en .json, .jsonl ou .csv, écrit dans
${EXPORT_DIR} ; la réponse complète va dans le fichier et l'outil ne renvoie qu'un accusé (chemin, taille, nombre de lignes, colonnes, aperçu).
Disponible sur les outils de lecture ; mettre limit au maximum admis par l'outil pour réduire le nombre d'appels.
` : ''}
Données de trafic en direct, avec les connexions déjà faites dans GPSEM (rien à reconnecter) : querySearchConsole (dimensions query, page, date,
device, country ; search_type=discover pour Discover, qui n'accepte que page, date et country), queryAnalytics (rapport GA4 libre : dimensions et
métriques GA4), queryBing, queryMerchant, queryYoutube. Une erreur source_not_connected signifie que la source n'est pas connectée pour ce site :
le signaler à l'utilisateur (connexion à faire une fois dans GPSEM) plutôt que d'insister.

Outils GPSEM (tableaux des écrans et de la boîte à outils) : listGpsemTools donne le catalogue groupé par thème — Indexation (pages non
indexées, crawlées non indexées, non crawlées depuis N jours, indexées à risque, désindexations récentes, non indexées avec backlinks),
Contenus et pruning, Mots-clés et Search Console (distribution, évolutions, questions, pages, cannibalisation), Maillage (orphelines, pages
à mailler, clusters), Netlinking, Analytics et conversions, Planning éditorial — puis getGpsemTool(cle=…) pour les données (limit, page).

Recherche de différences (archives du web) : pour savoir ce qui a changé sur une page ou un site, et quand — contenu refait, balise titre
ou meta description réécrites, changement de CMS ou de thème, outil installé ou retiré, fichiers CSS / JS. startDifferenceSearch (urls,
captures, mois ; du / au pour resserrer sur une période) lance la lecture des captures de la Wayback Machine en tâche de fond ; relire
getDifferenceSearch toutes les 20 à 30 secondes jusqu'à etat = ok (résumé par adresse et dates des gros changements, url=… pour le détail) ;
getDifferenceCapture donne le texte et les fichiers d'une capture ; listDifferenceSearches les recherches déjà faites (à consulter avant
d'en relancer une). Utile devant une baisse de trafic datée, ou pour voir ce qu'un concurrent a modifié. Les dates sont des fourchettes
entre deux captures de l'archive ; un outil « retiré » est une piste (il peut être chargé après consentement), pas une certitude.

Veille et tendances : getTrendingTopics (sujets en hausse pour le site, par cluster) pour proposer des contenus d'actualité ;
analyzeExternalContent(url) pour juger si une page externe (concurrent, actualité) a du sens pour le site (sujet, angle, mots-clés, pertinence),
puis addExternalContentIdea (idée seule) ou writeFromExternalContent (lance la rédaction : demander confirmation) ; listWatchedTopics,
watchTopic, refreshTopicInsights, unwatchTopic pour la veille récurrente.

Justifier les recommandations : searchKnowledge cherche dans la documentation Google Search Central (en français) ; citer l'URL de la source.
Les actions d'audit et les rapports de problèmes Screaming Frog portent déjà leurs references.

Éditeurs de contenu — le format du contenu dépend de l'éditeur de la page. Lire getPage (content=1) AVANT toute modification de contenu : le champ
editor vaut classique, gutenberg, elementor ou flexible, et content_type donne le type de contenu (page, post, slug d'un type).
- classique : content est du HTML simple (titres à partir de h2, paragraphes, listes, liens, images) ; l'écrire tel quel avec updatePage.
- gutenberg (éditeur de blocs WordPress) : content porte les blocs, délimités par des commentaires <!-- wp:nom {attributs} --> … <!-- /wp:nom -->.
  Pour retoucher une page existante : garder chaque délimiteur et ses attributs JSON intacts, ne changer que le texte à l'intérieur du bloc,
  sans changer sa balise ni ses classes ; ne jamais retirer un bloc inconnu (bloc d'une extension du site). Pour un nouveau contenu ou une
  réécriture complète : envoyer du HTML simple, GPSEM le découpe en blocs à l'envoi au site (titres, paragraphes, listes, images, citations,
  tableaux simples ; le reste en bloc « HTML personnalisé »).
- elementor (Elementor sur WordPress, Creative Elements sur PrestaShop) : la mise en page est dans elementor_data (getPage content=1), un arbre
  d'éléments { id, elType, widgetType, settings, elements } : section > column > widget, ou container > widget selon le site
  (getContentEditors → elementor.structure). content n'en est qu'une version HTML pour l'analyse. Pour modifier : reprendre l'arbre reçu, ne
  changer que les réglages de contenu des widgets visés (title d'un heading, editor d'un text-editor, text et link d'un button, image.url…),
  laisser tels quels les id, les réglages de style et les widgets non compris, puis renvoyer l'arbre COMPLET dans updatePage elementor_data
  (il remplace la structure). Ajouter un widget : seulement un widgetType listé par getContentEditors (addable), avec les réglages décrits par
  getContentEditors widget=nom (nom, type, valeur par défaut, options, condition) ; l'id d'un nouvel élément est facultatif.
  Envoyer content seul sur une page Elementor ne convient qu'aux petites retouches qui gardent le découpage du texte (lien ajouté, mot corrigé) :
  GPSEM les reporte dans les widgets ; sinon la réponse est 409 elementor_structure_conflict et il faut passer par elementor_data.
  updatePage editor=elementor convertit une page classique en structure Elementor simple et editor=classique fait l'inverse : dans les deux cas
  la mise en page existante de la page est remplacée, demander confirmation.
- flexible (flexible content ACF, WordPress) : les blocs se modifient dans GPSEM, pas avec ces outils ; ne pas écrire content sur ces pages.
createPage : du HTML simple suffit, GPSEM le met au format de l'éditeur du type de contenu au moment de l'envoi (blocs, ou structure Elementor
pour une page jamais publiée) ; pour une mise en page Elementor choisie, fournir elementor_data. Rien ne part au site sans push_to_cms=true ou
pushPageToCms. Réglages : getContentEditors donne l'éditeur par défaut du site, celui de chaque type de contenu, les éditeurs disponibles et les
widgets Elementor du site (refresh=1 réinterroge le site) ; updateContentEditors les change (default, content_types) — Elementor n'est proposé
que s'il est détecté sur le site, erreur elementor_unavailable sinon.
Si un autre MCP branché directement sur le site est disponible (WordPress / Gutenberg, Elementor), il peut servir à lire ou à préparer une mise
en page, mais écrire par GPSEM pour que la modification soit tracée dans l'historique et suivie. Une page modifiée directement sur le site doit
être réimportée (pullPageFromCms) avant d'être retravaillée ici : sinon le prochain envoi de GPSEM écrase cette modification.

Tracer chaque modification dans l'historique (addSiteHistorique) : c'est ce qui permet à GPSEM de mesurer l'effet des changements sur le trafic.
Lire d'abord getHistoriqueCodes et choisir le code le plus précis de la cible (100 site, 300 page, 310 catégorie, 320 archive) ; sinon le code générique
(100-09-001, 300-09-001, 310-09-001, 320-09-001) avec une description claire et l'avant / après dans details. updatePage et createPage écrivent leur historique eux-mêmes.

Maillage interne — chaque lien ajouté doit être tracé, page par page : addSiteHistorique code=300-02-003, page_id = la page qui REÇOIT le lien,
source_page_id = la page qui CONTIENT le lien, date = jour de mise en ligne, details.ancre = l'ancre (une entrée par lien). GPSEM peut alors dire
« la page 123 a reçu un lien de la page 456 le 12/09 » et vérifier si Google l'a recrawlée ou indexée ensuite : getPageLinksReceived (par page),
outil liens_internes_recents (tout le site). Avant de proposer du maillage, lire l'historique de la page (getPage → history, links_received).

Stats rapides d'indexation (getGpsemTool) : activite_google_par_jour, derniers_crawls, dernieres_indexations, desindexations_recentes, indexees_a_risque.

Audit technique à jour : launchScreamingFrogCrawl lance un crawl (de quelques minutes à quelques heures) ; suivre listScreamingFrogCrawls jusqu'au statut
« importe », puis lire getScreamingFrogDashboard, listScreamingFrogActions, getScreamingFrogIssue. createAuditReport régénère ensuite l'audit.
Liens cassés ou redirigés : ne pas corriger les pages une à une, utiliser runLinkCorrection (type 404 = retire les liens internes vers des 404/410, 301 = remplace
les liens internes redirigés en 301 par leur destination finale (liens externes jamais touchés), boucle = retire les liens vers des boucles de redirection) sur le dernier crawl. Lire d'abord
listLinkCorrections : une seule correction à la fois par site (409 correction_running, ex. « 404 en cours de nettoyage »), ne pas relancer
une correction en cours ni une correction déjà terminée depuis le dernier crawl. Suivre listLinkCorrections jusqu'à termine / erreur.

Rapports d'audit (createAuditReport, type) : resultats = informations générales et résultats (visibilité, positions, trafic, comportement,
concurrence, historique, marque dans le Knowledge Graph) ; technique = crawl, indexation, maillage, contenus, performance, données structurées ;
complet = toutes les sections ; knowledge_graph = entités seules (marque, auteurs, données structurées). Chaque rapport renvoie ses liens
aperçu, PDF et PowerPoint (links.pptx) à transmettre à l'utilisateur.

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

Actions à effet réel (demander confirmation à l'utilisateur avant) : orderBacklinks (achat), writeFromExternalContent (rédaction), launchScreamingFrogCrawl (charge le serveur de crawl), runLinkCorrection (modifie les contenus et les renvoie au CMS), createSite (consomme le quota), createPage / updatePage avec push_to_cms, pushPageToCms, syncSite,
createContent / writeContentIdea (rédaction automatique), createAuditReport, updateCompanyInfo, updateSiteSettings, updateContentEditors, updateLegalNotice,
updatePage avec editor=elementor ou editor=classique (remplace la mise en page de la page).
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
      // Export en fichier : deux arguments de plus sur les outils de lecture, seulement si GPSEM_EXPORT_DIR est défini
      if (lecture && EXPORT_DIR && !proprietes.enregistrer_sous && !proprietes.toutes_les_pages) {
        proprietes.enregistrer_sous = {
          type: 'string',
          description: 'Enregistre la réponse COMPLÈTE (sans troncature) dans ce fichier au lieu de la renvoyer : nom relatif, ex. « pages-site.json », '
            + `extension .json, .jsonl ou .csv, écrit dans ${EXPORT_DIR}. L'outil ne renvoie alors qu'un accusé (chemin, taille, lignes, colonnes, aperçu).`,
        };
        proprietes.toutes_les_pages = {
          type: 'boolean',
          default: false,
          description: `Avec enregistrer_sous : enchaîne toutes les pages de la réponse (limit / page ou offset) et les réunit dans le même fichier (${EXPORT_MAX_PAGES} pages au plus).`,
        };
      }
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

/** Chemin du fichier d'export, résolu dans EXPORT_DIR ; refuse un nom qui en sort ou une extension non admise. */
function cheminExport(nom) {
  const refus = (raison) => new Error(`Chemin refusé (« ${nom} ») : ${raison}.`);
  if (typeof nom !== 'string' || !nom.trim()) throw new Error('enregistrer_sous attend un nom de fichier relatif, ex. « pages-site.json ».');
  const propre = nom.trim();
  if (propre.includes('\0')) throw refus('caractère interdit');
  if (path.isAbsolute(propre) || path.win32.isAbsolute(propre) || /^[\\/]/.test(propre) || /^[a-zA-Z]:/.test(propre)) {
    throw refus('chemin absolu, donner un nom relatif au dossier d\'export');
  }
  if (propre.split(/[\\/]+/).includes('..')) throw refus('« .. » interdit');
  const extension = path.extname(propre).toLowerCase();
  if (!EXPORT_EXTENSIONS.includes(extension)) throw refus(`extensions admises : ${EXPORT_EXTENSIONS.join(', ')}`);
  const cible = path.resolve(EXPORT_DIR, propre);
  if (!cible.startsWith(EXPORT_DIR + path.sep)) throw refus('hors du dossier d\'export');
  mkdirSync(path.dirname(cible), { recursive: true });
  // Un lien symbolique placé dans le dossier d'export ne doit pas permettre d'en sortir
  const racine = realpathSync(EXPORT_DIR);
  const dossier = realpathSync(path.dirname(cible));
  if (dossier !== racine && !dossier.startsWith(racine + path.sep)) throw refus('hors du dossier d\'export');
  return { cible, extension };
}

/** Lignes d'une réponse : data si c'est une liste, sinon la seule liste portée par data ; null si la réponse n'est pas tabulaire. */
function lignesDe(body) {
  if (!body || typeof body !== 'object') return null;
  if (Array.isArray(body)) return { lignes: body, cle: 'data' };
  const data = body.data;
  if (Array.isArray(data)) return { lignes: data, cle: 'data' };
  if (data && typeof data === 'object') {
    const listes = Object.entries(data).filter(([, v]) => Array.isArray(v));
    const choisie = listes.length === 1 ? listes[0] : listes.find(([k]) => ['rows', 'items', 'lignes', 'results', 'data'].includes(k));
    if (choisie) return { lignes: choisie[1], cle: `data.${choisie[0]}` };
  }
  return null;
}

/** Colonnes d'une liste : union des clés de premier niveau, dans l'ordre de première apparition. */
function colonnesDe(lignes) {
  const colonnes = new Set();
  for (const l of lignes) {
    if (l && typeof l === 'object' && !Array.isArray(l)) for (const k of Object.keys(l)) colonnes.add(k);
  }
  return [...colonnes];
}

/** CSV : séparateur « ; », valeurs imbriquées en JSON, UTF-8 avec BOM. */
function versCsv(lignes, colonnes) {
  const cellule = (v) => {
    if (v === undefined || v === null) return '';
    const t = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[";\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const sorties = [(colonnes.length ? colonnes : ['valeur']).map(cellule).join(';')];
  for (const l of lignes) {
    const objet = l && typeof l === 'object' && !Array.isArray(l);
    sorties.push(colonnes.length && objet ? colonnes.map((c) => cellule(l[c])).join(';') : cellule(l));
  }
  return `﻿${sorties.join('\r\n')}\r\n`;
}

/** Ligne raccourcie pour l'aperçu de l'accusé : les valeurs longues ou imbriquées sont coupées. */
function apercu(ligne) {
  const court = (v) => {
    const t = typeof v === 'string' ? v : v && typeof v === 'object' ? JSON.stringify(v) : null;
    return t !== null && t.length > 160 ? `${t.slice(0, 160)}…` : v;
  };
  if (ligne && typeof ligne === 'object' && !Array.isArray(ligne)) {
    return Object.fromEntries(Object.entries(ligne).slice(0, 40).map(([k, v]) => [k, court(v)]));
  }
  return court(ligne);
}

/**
 * Exécute un outil de lecture et enregistre sa réponse complète dans un fichier de EXPORT_DIR ; renvoie { texte, erreur },
 * texte étant l'accusé destiné à l'assistant. Avec toutesLesPages, enchaîne les pages (page ou offset) jusqu'au bout.
 */
async function exporter(outil, args, nom, toutesLesPages) {
  if (!EXPORT_DIR) {
    throw new Error('export en fichier non activé : définir la variable d\'environnement GPSEM_EXPORT_DIR (dossier de destination) dans la configuration du serveur MCP.');
  }
  if (outil.methode !== 'get') throw new Error('enregistrer_sous n\'est disponible que sur les outils de lecture.');
  const { cible, extension } = cheminExport(nom);
  const noms = outil.parametres.map((p) => p.nom);
  const mode = noms.includes('page') ? 'page' : noms.includes('offset') ? 'offset' : null;

  const premiere = await executer(outil, args);
  if (premiere.status >= 400) return { texte: texteReponse(premiere), erreur: true };
  const tabulaire = lignesDe(premiere.body);
  if (!tabulaire && extension !== '.json') {
    throw new Error(`réponse non tabulaire (pas de liste dans data) : export ${extension} impossible, utiliser un nom en .json.`);
  }

  const notes = [];
  let lignes = tabulaire ? tabulaire.lignes.slice() : null;
  const meta = !Array.isArray(premiere.body) && premiere.body?.meta && typeof premiere.body.meta === 'object' ? premiere.body.meta : null;
  const total = meta && meta.total !== null && meta.total !== '' && Number.isFinite(Number(meta.total)) ? Number(meta.total) : null;
  let pagesLues = 1;
  const fusion = toutesLesPages && !!tabulaire && !!mode;
  let interrompu = false;
  if (fusion) {
    const parPage = Number(args.limit) || Number(meta?.limit) || Number(meta?.per_page) || null;
    let page = Number(args.page) || Number(meta?.page) || 1;
    const debut = mode === 'offset' ? Number(args.offset) || 0 : (page - 1) * (parPage || 0);
    let recues = lignes.length;
    let precedente = JSON.stringify(tabulaire.lignes);
    while (recues > 0) {
      if (total !== null ? debut + lignes.length >= total : parPage !== null && recues < parPage) break;
      const suivante = mode === 'page' ? `page=${page + 1}` : `offset=${debut + lignes.length}`;
      if (pagesLues >= EXPORT_MAX_PAGES) {
        interrompu = true;
        notes.push(`Arrêt au garde-fou de ${EXPORT_MAX_PAGES} pages (GPSEM_EXPORT_MAX_PAGES) : le fichier est incomplet. Reprendre à ${suivante} dans un autre fichier, ou augmenter limit.`);
        break;
      }
      let r;
      try {
        r = await executer(outil, mode === 'page' ? { ...args, page: page + 1 } : { ...args, offset: debut + lignes.length });
      } catch (e) {
        r = { status: 0, body: e.message };
      }
      const t = r.status >= 200 && r.status < 400 ? lignesDe(r.body) : null;
      if (!t) {
        const motif = r.status === 0 ? `appel impossible (${r.body})`
          : r.status >= 400 ? `erreur HTTP ${r.status} ${(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)).slice(0, 300)}` : 'réponse sans liste';
        interrompu = true;
        notes.push(`Pagination interrompue à ${suivante} : ${motif}. Les ${pagesLues} page(s) déjà lues sont dans le fichier ; reprendre à ${suivante} dans un autre fichier.`);
        break;
      }
      const empreinte = JSON.stringify(t.lignes);
      if (t.lignes.length && empreinte === precedente) {
        notes.push('Pagination arrêtée : la page suivante est identique à la précédente (cet outil ne pagine pas avec ces arguments).');
        break;
      }
      precedente = empreinte;
      recues = t.lignes.length;
      if (recues) {
        lignes = lignes.concat(t.lignes);
        pagesLues += 1;
        page += 1;
      }
    }
    if (!interrompu && !notes.length && total !== null && debut + lignes.length < total) {
      notes.push(`${lignes.length} lignes reçues pour meta.total = ${total} : l'API n'a pas renvoyé la suite.`);
    }
  } else if (toutesLesPages) {
    notes.push(tabulaire ? 'toutes_les_pages sans effet : cet outil n\'a ni argument page ni argument offset, une seule réponse a été enregistrée.'
      : 'toutes_les_pages sans effet : la réponse n\'est pas une liste paginée.');
  }

  const colonnes = lignes ? colonnesDe(lignes) : [];
  let contenu;
  if (extension === '.csv') contenu = versCsv(lignes, colonnes);
  else if (extension === '.jsonl') contenu = lignes.map((l) => `${JSON.stringify(l)}\n`).join('');
  else if (fusion) contenu = JSON.stringify({ meta: { ...meta, pages_lues: pagesLues, lignes: lignes.length }, data: lignes }, null, 1);
  else contenu = typeof premiere.body === 'string' ? premiere.body : JSON.stringify(premiere.body, null, 1);
  // Le jeton ne doit jamais se retrouver dans un fichier, même si une réponse le renvoyait
  if (TOKEN) contenu = contenu.split(TOKEN).join('[jeton masqué]');
  writeFileSync(cible, contenu, 'utf8');

  const accuse = {
    fichier: cible,
    format: extension.slice(1),
    taille_octets: Buffer.byteLength(contenu, 'utf8'),
    lignes: lignes ? lignes.length : null,
    meta_total: total,
    pages_lues: pagesLues,
    ...(tabulaire && tabulaire.cle !== 'data' ? { liste_lue_dans: tabulaire.cle } : {}),
    colonnes,
    apercu: lignes ? lignes.slice(0, 3).map(apercu) : apercu(premiere.body),
    ...(notes.length ? { attention: notes.join(' ') } : {}),
  };
  let texte = `${interrompu ? 'Export INCOMPLET' : 'Réponse enregistrée'} dans le fichier (contenu non renvoyé ici) :\n${JSON.stringify(accuse, null, 1)}`;
  if (TOKEN) texte = texte.split(TOKEN).join('[jeton masqué]');
  if (texte.length > MAX_CHARS) texte = `${texte.slice(0, MAX_CHARS)}\n[Accusé tronqué.]`;
  return { texte, erreur: interrompu };
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
      const args = requete.params.arguments || {};
      // Export en fichier, sauf si l'API a elle-même un paramètre de ce nom
      if (args.enregistrer_sous !== undefined && args.enregistrer_sous !== '' && !outil.parametres.some((p) => p.nom === 'enregistrer_sous')
        && !outil.corps?.champs?.includes('enregistrer_sous')) {
        const e = await exporter(outil, args, args.enregistrer_sous, args.toutes_les_pages === true || args.toutes_les_pages === 'true');
        return { isError: e.erreur, content: [{ type: 'text', text: e.texte }] };
      }
      const r = await executer(outil, args);
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
