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
 *   GPSEM_MODULES    (facultatif)  modules chargés : seo, sea, campagnes, local, netlinking (socle toujours) ; absent = tous
 *   GPSEM_PROFIL     (facultatif)  seo ou ads : serveur nommé gpsem-seo / gpsem-ads (aussi par les commandes du même nom)
 *   GPSEM_MODE       (facultatif)  decouverte = 3 outils (findTools, describeTool, callTool) au lieu de la liste complète
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

/**
 * Modules : chaque outil appartient à un module, d'après le tag de son opération dans la spécification.
 * Le socle est toujours chargé ; GPSEM_MODULES choisit les autres (absent = tous, comme avant la 0.17.0).
 * Une opération peut fixer son module elle-même avec x-mcp-module ; un tag inconnu tombe dans le socle (l'outil n'est jamais perdu).
 */
const MODULES = {
  socle: { libelle: 'compte, sites, historique, rapports, outils GPSEM, connaissances', tags: ['Auth', 'Compte', 'Entreprise', 'Site', 'Historique', 'Rapports', 'Outils GPSEM', 'Connaissances'] },
  seo: { libelle: 'Search Console, GA4, audit, contenus, Screaming Frog, indexation, rédaction, synchro CMS, Opquast, veille', tags: ['Analyses', 'Sources de données', 'Audit', 'Contenus du site', 'Screaming Frog', 'Indexation', 'Rédaction', 'Synchronisation CMS', 'Opquast', 'Veille et tendances'] },
  sea: { libelle: 'conseil publicité : analyse et pilotage Google Ads, Microsoft Ads, Meta Ads, autres régies, intérêts Meta / TikTok, changements à valider', tags: ['Publicité'] },
  campagnes: { libelle: 'création de campagnes Google Ads (fiche économique, plans Search / Performance Max / Demand Gen / YouTube / Display, lieux, mots-clés, images, création en pause)', tags: [] },
  local: { libelle: 'SEO local : établissements, fiches, avis, géogrille, publications', tags: ['SEO local'] },
  netlinking: { libelle: 'backlinks, achat MyBack.link, spots de liens', tags: ['Backlinks', 'Spots de liens'] },
};
const ALIAS_MODULES = {
  ads: 'sea', publicite: 'sea', pub: 'sea', conseil: 'sea', creation: 'campagnes', campagne: 'campagnes', 'seo-local': 'local', seolocal: 'local', liens: 'netlinking', backlinks: 'netlinking', link: 'netlinking',
};
// Outils rangés ailleurs que leur tag : les explorateurs d'intérêts Meta / TikTok (tag Analyses) servent la publicité, les outils transverses le socle
const MODULE_PAR_CHEMIN = [[/\/(meta|tiktok)\//, 'sea']];
// Lire les pages du site sert à tous les modules (annonces, fiches, contenus) : dans le socle
const MODULE_PAR_OUTIL = { getTask: 'socle', searchEverywhere: 'socle', getSitePortfolio: 'socle', listPages: 'socle', getPage: 'socle' };

function lireModules(brut) {
  const noms = String(brut || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[\s,;]+/).filter(Boolean);
  if (!noms.length || noms.some((n) => ['tout', 'tous', 'all', '*'].includes(n))) return new Set(Object.keys(MODULES));
  const actifs = new Set(['socle']);
  for (const n of noms) {
    const m = ALIAS_MODULES[n] || n;
    if (MODULES[m]) actifs.add(m);
    else console.error(`GPSEM_MODULES : module inconnu « ${n} » ignoré (modules : ${Object.keys(MODULES).join(', ')}).`);
  }
  return actifs;
}
/**
 * Profils : serveurs nommés « gpsem-seo » et « gpsem-ads » (bin du paquet, ou GPSEM_PROFIL). Un profil borne les
 * modules : GPSEM_MODULES ne peut que réduire la liste (le reste est ignoré). Le jeton à périmètre de l'API fait la
 * même séparation côté serveur.
 */
const PROFILS = {
  seo: { nom: 'gpsem-seo', libelle: 'GPSEM SEO', permis: ['seo', 'netlinking', 'local'], defaut: ['seo', 'netlinking'] },
  ads: { nom: 'gpsem-ads', libelle: 'GPSEM Ads', permis: ['sea', 'campagnes'], defaut: ['sea', 'campagnes'] },
};
const PROFIL = PROFILS[String(process.env.GPSEM_PROFIL || '').trim().toLowerCase()] || null;
function modulesDuProfil() {
  if (!PROFIL) return lireModules(process.env.GPSEM_MODULES);
  const demandes = process.env.GPSEM_MODULES ? lireModules(process.env.GPSEM_MODULES) : new Set(['socle', ...PROFIL.defaut]);
  const actifs = new Set(['socle']);
  for (const m of demandes) {
    if (m === 'socle') continue;
    if (PROFIL.permis.includes(m)) actifs.add(m);
    else console.error(`${PROFIL.nom} : module « ${m} » ignoré (hors du profil ; modules possibles : ${PROFIL.permis.join(', ')}).`);
  }
  if (actifs.size === 1) PROFIL.defaut.forEach((m) => actifs.add(m));
  return actifs;
}
const MODULES_ACTIFS = modulesDuProfil();
const DECOUVERTE = ['decouverte', 'découverte', 'discovery'].includes(String(process.env.GPSEM_MODE || '').trim().toLowerCase());

const CONSIGNES = [
  ['socle', `GPSEM est une plateforme SEO et SEA. Ces outils lisent et modifient les données d'un compte GPSEM (entreprise, sites, pages, audits, publicité).

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
` : ''}`],
  ['seo', `Données de trafic en direct, avec les connexions déjà faites dans GPSEM (rien à reconnecter) : querySearchConsole (dimensions query, page, date,
device, country ; search_type=discover pour Discover, qui n'accepte que page, date et country), queryAnalytics (rapport GA4 libre : dimensions et
métriques GA4), queryBing, queryMerchant, queryYoutube. Une erreur source_not_connected signifie que la source n'est pas connectée pour ce site :
le signaler à l'utilisateur (connexion à faire une fois dans GPSEM) plutôt que d'insister.`],
  ['socle', `Outils GPSEM (tableaux des écrans et de la boîte à outils) : listGpsemTools donne le catalogue groupé par thème — Indexation (pages non
indexées, crawlées non indexées, non crawlées depuis N jours, indexées à risque, désindexations récentes, non indexées avec backlinks),
Contenus et pruning, Mots-clés et Search Console (distribution, évolutions, questions, pages, cannibalisation), Maillage (orphelines, pages
à mailler, clusters), Netlinking, Analytics et conversions, Planning éditorial — puis getGpsemTool(cle=…) pour les données (limit, page).

Recherche de différences (archives du web) : pour savoir ce qui a changé sur une page ou un site, et quand — contenu refait, balise titre
ou meta description réécrites, changement de CMS ou de thème, outil installé ou retiré, fichiers CSS / JS. startDifferenceSearch (urls,
captures, mois ; du / au pour resserrer sur une période) lance la lecture des captures de la Wayback Machine en tâche de fond ; relire
getDifferenceSearch toutes les 20 à 30 secondes jusqu'à etat = ok (résumé par adresse et dates des gros changements, url=… pour le détail) ;
getDifferenceCapture donne le texte et les fichiers d'une capture ; listDifferenceSearches les recherches déjà faites (à consulter avant
d'en relancer une). Utile devant une baisse de trafic datée, après un piratage, ou pour voir ce qu'un concurrent a modifié. Les dates sont
des fourchettes entre deux captures de l'archive ; un outil « retiré » est une piste (il peut être chargé après consentement), pas une certitude.
Chaque date de gros changement est placée par rapport aux mises à jour Google (champ google : pendant, entre — precedente / suivante avec
l'écart en jours —, ou a_affiner : relancer avec du / au sur la fourchette). listGoogleUpdates (from, to, type) donne les mises à jour seules.`],
  ['seo', `CAS D'USAGE SEO — enchaîner les outils plutôt que répondre sur un seul chiffre. Toujours dater (quand ça a commencé, sur quelles pages), puis
chercher ce qui s'est passé à ce moment : sur le site (historique, archives), chez Google (mises à jour), dans les données (Search Console).

1. Audit suite à un problème (baisse de trafic, désindexation, piratage) :
   a. Mesurer et dater : querySearchConsole par date (clics, impressions, position) sur 16 mois, puis par page et par requête sur la période
      avant / après la baisse ; comparer avec la même période l'an passé (saisonnalité). getNavrankAnalysis (tendance, anomalies,
      impact_updates) si le site a des relevés NavRank. Distinguer une baisse générale (tout le site) d'une baisse de quelques pages ou
      d'un type de page (catégories, fiches produit, articles) : ce n'est pas la même cause.
   b. Google : listGoogleUpdates autour de la date. Si la baisse commence pendant un déploiement : getNavrankAnalysis update=id (4 semaines
      avant / après). Core update = qualité perçue de l'ensemble du site ; spam / link spam = pratiques (liens, contenus, pages piratées) ;
      helpful content / reviews = contenus. Une coïncidence de dates est un indice, jamais une preuve : le dire.
   c. Le site : getSiteHistorique (from / to autour de la date) pour les changements tracés ; puis startDifferenceSearch sur 3 à 10 adresses
      représentatives (accueil, pages qui ont le plus perdu, une page de chaque modèle) sur une période qui encadre la baisse. Lire les
      dates des gros changements et leur champ google : changement AVANT la mise à jour = il a pu être jugé par elle ; changement APRÈS =
      souvent une réaction à la baisse (ou sans lien) ; aucun changement = chercher ailleurs (concurrence, liens, technique, Google seul).
   d. Si changement : inspecter ce qui a bougé — getDifferenceSearch url=… (passages ajoutés / retirés, fichiers CSS et JS), getDifferenceCapture
      (texte, titres, données structurées), outils installés / retirés (changement de CMS, de thème, d'extension, scripts tiers inconnus).
      Piratage : scripts ou domaines tiers apparus, texte ou liens sans rapport avec le sujet du site, title / meta réécrites (spam japonais,
      pharmacie, casino), redirections ; vérifier les pages qui en sont touchées (getPage, desindexations_recentes, getScreamingFrogIssue).
   e. Technique : dernier crawl Screaming Frog (getScreamingFrogDashboard), indexation (getGpsemTool pages_non_indexees,
      desindexations_recentes, activite_google_par_jour). Conclure en hiérarchisant les causes probables, avec les preuves, et un plan d'action.

2. Audit pour améliorer le site : listReportsForSite puis listAuditSections / getAuditSection, listAuditActions ; createAuditReport pour un
   rapport complet à jour (après un crawl récent). Compléter par listGpsemTools (indexation, pruning, maillage, cannibalisation) et la
   cartographie sémantique. Justifier avec searchKnowledge.

3. Recherche d'amélioration des positions : mots-clés en page 2 (positions 8 à 20 avec impressions : querySearchConsole query + page),
   cannibalisation, pages à mailler et orphelines (listLinkSuggestions, listOrphanPages), getNavrankAnalysis (pépites cachées, clics
   déçus = title / meta à revoir), concurrents (outils Semrush, startDifferenceSearch sur la page concurrente qui a gagné : qu'a-t-elle
   changé, et quand). Proposer peu de pages, les plus rentables, avec la modification précise.

4. Suivi et contrôle d'un site ou d'une URL : getPage (indexation, scores des 4 dernières semaines, 20 derniers événements) ; getSiteHistorique
   page_id=… pour tout l'historique, dont les passages de Google (code 700-01-003, à demander explicitement) ; derniers_crawls,
   dernieres_indexations. Après une modification, l'historique sert à attendre que Google repasse : comparer la date du changement
   (300-…) avec le premier crawl Google qui suit, et ne juger l'effet (querySearchConsole page=… avant / après) qu'à partir de ce passage
   et après 2 à 4 semaines. Tant que Google n'est pas repassé, dire qu'il est trop tôt plutôt que de conclure.
   Indexation : getIndexationStatus (bilan des tests, file, erreurs, quota) ; runIndexTests page_ids / urls pour vérifier tout de suite
   qu'une page modifiée ou nouvelle est indexée (résultat dans getPage : is_indexed, test_index, après traitement de la file) ;
   requestIndexing pour signaler à Google des pages modifiées ou non indexées (lot = nonindexees), puis listIndexingRequests et un
   nouveau test quelques jours plus tard. Tester les pages utiles, pas tout le site à répétition (quota Search Console de 2 000
   inspections par jour et par site) ; une page non indexée qui reste non indexée malgré une demande est un problème de qualité ou
   de maillage, pas d'envoi : le dire et chercher la cause (contenu, liens reçus, doublon, canonique).`],
  ['netlinking', `Liens obtenus soi-même (ninjalinking, JAMAIS d'achat) : getLinkSpotSettings (cibles du site : site, entreprise, personne ; pays ;
   langues ; inscriptions par semaine au plus ; black hat autorisé ou non) ; listLinkPlansToDo (liens planifiés à réaliser) ;
   searchLinkSpots (planification=id pour un lien planifié, sinon type / cible / portée locale, nationale ou internationale / pays /
   gratuit / dofollow) ; getLinkSpot pour la procédure de LA cible choisie (sur un même site, l'inscription d'une entreprise et celle
   d'une personne n'ont souvent rien à voir) ; inscription avec un vrai contenu (description unique, informations exactes et identiques
   partout : nom, adresse, téléphone) ; puis setLinkSpotStatus : en_cours dès le début, soumis si le site valide à la main, obtenu avec
   url_profil (la page où se trouve le lien) et planification_id. CAPTCHA, code reçu par SMS ou e-mail illisible, paiement demandé :
   s'arrêter, laisser en_cours avec une note, ou ecarte si le site est devenu payant.
   Respecter le rythme par semaine. Black hat : jamais sans l'option du site, et jamais l'activer (updateLinkSpotSettings) sans l'accord
   explicite de l'utilisateur. Un spot « a_verifier » ou « joignable » n'est pas encore confirmé gratuit : vérifier avant de remplir.`],
  ['local', `SEO local (préversion, entreprises autorisées seulement ; 403 ailleurs) : getLocalModuleStatus d'abord — en mode demo, toutes les
   fiches, statistiques et expressions sont FICTIVES : le dire, ne jamais les présenter comme des données réelles. getLocalDashboard
   (vues, actions, changements à traiter, modifications en attente), listLocations puis getLocation (référence GPSEM, fiche publiée,
   écarts ; fraiche=1 pour relire). Modifier une fiche : previewListingUpdate (garde-fous : un blocage se corrige, un avertissement se
   montre à l'utilisateur), puis proposeListingUpdate avec avertissements_lus=true seulement si l'utilisateur a lu les avertissements.
   Une proposition n'est JAMAIS envoyée par l'agent : une personne la valide et l'applique dans GPSEM ; le dire. Ne jamais ajouter de
   ville ni de mot-clé au nom (sanctionné par Google). Veille : listListingChanges (changements faits hors de GPSEM ou proposés par
   Google), resolveListingChange (accepter / retablir / ignorer : demander à l'utilisateur pour un changement de gravité haute ou
   critique). Effet d'une modification : getListingHistory pour la dater, puis getLocationPerformance (periode, comparer=annee,
   serie=appels…) et getLocationSearchKeywords ; attendre 2 à 4 semaines avant de juger. Les expressions « moins de N » ne s'additionnent pas.
   Audit : runLocalAudit (ou getLocalAudit pour le dernier) ; la note ne porte que sur les contrôles évalués — un contrôle non_evalue
   n'est JAMAIS un échec, le dire « non vérifié ». Présenter le plan (par cause, risques d'abord) avec l'outil qui corrige ; réseau :
   getLocalNetworkAudit (actions de marque = une correction pour tous). listLocalAuditChecks donne les règles et seuils.
   Avis : syncLocalReviews puis listReviews (repondu=non, notes=1,2 d'abord) ; draftReviewReply (IA de l'entreprise, ne rien inventer)
   puis replyToReview : la réponse attend TOUJOURS une validation humaine (le dire). Jamais de promesse, de geste commercial, de lien ni
   de donnée personnelle. getReviewStats : thèmes à traiter (avec les avis cités), rythme, simulateur (cible=4.5) ; getReviewRequestKit
   pour les liens de demande : à proposer à TOUS les clients, sans contrepartie ni tri.
   Positions (géogrille Google Maps) : estimateLocalGrid TOUJOURS d'abord (points, coût sur le compte DataForSEO de l'entreprise,
   plafond restant) ; annoncer le coût et ne lancer runLocalGridScan qu'avec l'accord de l'utilisateur (confirmer=true au-delà du
   seuil). En mode demo les relevés sont simulés (donnees_fictives=true) : le dire. getLocalGridScan (points=1 pour le détail) :
   part top 3, rang moyen, part de voix, concurrents ; ne comparer que deux relevés de la même série (listLocalGridSeries), ou avec
   avec=<id> pour une comparaison libre (même grille, réglages différents : le dire). runLocalGridScan accepte expressions (1 à 10, un
   relevé par expression, coût multiplié : l'annoncer). getLocalGridScan donne aussi potentiel (ordre de grandeur des appels / visites /
   itinéraires gagnés en entrant dans le top 3, jamais une promesse) et evolution_concurrents (nouveaux, sortis, avis, catégories).
   Rang par expression : listLocalKeywordRanks (pack local + rang du site, quotidien, 25 expressions) ; trackLocalKeywords ajoute des
   expressions ; verifier=true dépense des crédits DataForSEO hors démonstration : accord de l'utilisateur.
   Site : listLocalPages puis getLocalPageAudit (écarts fiche ↔ page, note, balisage) ; corriger la page = dans le CMS (le dire), la fiche =
   proposeListingUpdate. generateLocalSchema donne le JSON-LD à coller (jamais de note auto-attribuée). fixListingLinksTracking prépare une
   modification à valider. listDoorwayPageGroups : proposer enrichir / fusionner / rediriger, jamais supprimer sans accord. draftLocalPage :
   relire les [À COMPLÉTER] avec l'utilisateur, ne rien inventer, refus normal pour un service × lieu sans différence réelle.
   Publications : suggestPostIdeas / proposeEditorialPlan pour le fond, draftPost (refus si chiffre absent de la source), createPost avec
   apercu=true d'abord (garde-fous, similarité entre établissements), puis createPost : la publication attend TOUJOURS une validation humaine.
   schedulePost (répétition chaque semaine / mois, nombre d'envois ou date de fin) ; importPosts : aperçu d'abord (pretes=false = erreurs à
   montrer), création en brouillons ; listPostTemplates pour repartir d'un modèle.
   Jamais de numéro de téléphone dans le texte. getMediaAudit pour les photos (l'envoi de photos se fait dans GPSEM) ; listLocationFaq /
   saveLocationFaq : réponses vraies seulement.
   Présence : getLocationPresence (a_verifier n'est JAMAIS une absence ; « forme » n'est pas une erreur), corriger d'abord la source amont.
   scanCitations coûte quelques dixièmes de centime sur le DataForSEO de l'entreprise : accord de l'utilisateur hors démonstration.
   recordCitation seulement avec ce que l'utilisateur a vu ou confirmé ; getPresenceMatrix pour un réseau (tâches par priorité).
   Concurrence : listCompetitors (score expliqué : citer les composants et les manquants), compareCompetitors (écarts → action), runMarketStudy
   (gratuit, lent) : signaux = HYPOTHÈSES, toujours citer les limites des données. listSuspiciousListings : dire « à examiner », jamais
   « frauduleux » ; l'utilisateur signale lui-même.
   Réseau : getNetworkDashboard (rangs, hors norme, groupes) ; previewBulkUpdate = aperçu seulement, puis appliquer=id après accord de
   l'utilisateur (chaque fiche reste à valider) ; un champ verrouillé par le siège est refusé : ne pas insister, le dire. listApprovals
   montre ce qui attend une personne : un agent ne valide jamais.
   IA : getLocalAiVisibility (fréquence de citation sur plusieurs essais, pas un rang fixe ; faits erronés → source probable dans les
   annuaires). runLocalAiScan consomme les clés IA de l'entreprise : annoncer estimation.appels et obtenir l'accord hors démonstration.
   Prospection (agences) : scanProspects coûte environ 0,002 $ (accord hors démo), listProspects (chauds d'abord), getProspect.arguments
   pour un message de prise de contact factuel ; jamais de donnée personnelle. Rapport : getLocalReport pour un bilan ;
   shareLocalReport rend les chiffres lisibles par quiconque a le lien : demander l'accord, et consentement=true seulement si
   l'utilisateur confirme que l'établissement a accepté ce lien public (durée 1, 7, 14 ou 30 jours).
   Propositions en deux temps : proposeLocalAction prépare une action (réponse, publication, modification de fiche…) et renvoie un
   identifiant valable 15 MINUTES avec « ce qu'elle fera » ; dire à l'utilisateur de l'appliquer dans GPSEM (écran Agents IA) avant
   l'expiration — appliquer crée l'élément habituel en attente de validation, rien n'est publié. listLocalProposals / getLocalProposal
   pour suivre, cancelLocalProposal si l'utilisateur renonce. Un blocage (garde-fou, champ verrouillé par le siège) est refusé : ne pas
   contourner. Ressources utiles : listLocalResources puis getLocalResource (file-validations, propositions, changements-google,
   journal-recent).
   Trouver un établissement non géré : findLocalBusiness (adresse Google Maps ou « nom, ville » ; la recherche par nom coûte un peu sur
   le DataForSEO de l'entreprise, refusée à un jeton en lecture seule) puis runQuickLocalGridScan (estimation_seule=true d'abord) ou,
   pour un établissement géré, runLocalGridScan. createLocationFromBusiness ajoute un établissement trouvé (sans lien Google, « à relier ») ; createLocation / updateLocation / tagLocations pour le réseau, planLocationLifeEvent pour un déménagement, une fermeture ou un changement d'enseigne (plan de tâches ; la fiche passe par la validation). compareLocalGridScans (a, b) : gagnés / perdus / en hausse / en baisse ; si
   grille_differente=true, ne rien conclure sans le dire. getLocalGridHeadToHead : ma grille face à celle d'un concurrent. Seuls les
   points « trouvé » et « absent » comptent dans les indicateurs ; « incomplet », « erreur », « non mesuré » sont exclus : le dire.
   Avis : listReviewAssignees / assignReview (seulement les personnes du site), getReviewTopicTrends (thèmes par mois),
   classifyReviewTopics consomme l'IA de l'entreprise (accord). Publications : la langue choisie est celle envoyée à Google ;
   searchStockImages / addStockImage (banque libre, auteur et licence gardés) et generatePostImage (IA de l'entreprise, accord) servent
   aux PUBLICATIONS seulement, jamais aux photos de la fiche. Établissements : searchLocations, listImportableLocations puis
   importSelectedLocations (100 au plus, accord), getVerificationState, bulkResolveOutsideChanges (demander pour une gravité haute),
   listCitations / saveCitation (ce que l'utilisateur a vu), searchCities. Recherche transversale : searchLocalEverything ;
   notifications du module : listLocalNotifications.`],
  ['sea', `SEA (publicité : Google Ads, Microsoft Ads, Meta Ads, LinkedIn et autres régies connectées dans GPSEM) : getAdsCampaigns pour l'état
des comptes, getAdsAudit / runAdsAudit (note sur 100, priorités chiffrées en €/30 j), diagnoseAdsChange AVANT de conseiller un changement après
une baisse (délai de conversion, suivi, demande, budget, saison), getAdsSafetyRules pour expliquer pourquoi une règle ne propose rien ou
pourquoi un changement est bloqué. Modifier un compte de préférence en deux temps : runAdsRule puis proposeAdsRuleRows (ou addAdsProposals)
met les lignes dans la file sans rien changer ; getAdsProposals montre la file ; l'utilisateur décide (decideAdsProposals) ; puis
applyAdsProposals. Une écriture directe (applyAdsRule, excludePaidTerms, setAdsBudgets, setMetaAdsBudget, setMetaAdsStatus…) touche un budget
réel : dry_run=true d'abord quand l'outil l'accepte, accord explicite de l'utilisateur, et jamais force=true sans qu'il l'ait demandé après
avoir lu les alertes. Chaque écriture est inscrite au journal (getAdsChangeHistory) et annulable (undoAdsAction, undoMetaAdsAction).
prepareMetaBoost crée tout EN PAUSE : rien n'est dépensé tant que la personne ne l'active pas dans Meta. Intérêts Meta / TikTok
(searchMetaInterests, estimateMetaAudience, searchTiktokInterests…) : préparation du ciblage, sans dépense.
Rôle de conseil : diagnostiquer, expliquer, proposer des changements dans la file ; juger un CPA ou un ROAS face à la fiche économique
(getAdsEconomics : cibles et équilibre). Créer une nouvelle campagne relève du module « campagnes » (agent de création) : s'il n'est pas
chargé, le dire à l'utilisateur plutôt que d'improviser.`],
  ['campagnes', `CRÉER UNE CAMPAGNE GOOGLE ADS (ex. « une campagne pour une entreprise d'électricité industrielle en Haute-Savoie, uniquement en local ») :
0. Type (createCampaignPlan type) : SEARCH pour capter une demande exprimée (service local, B2B, urgence) — presque toujours le premier ;
   PERFORMANCE_MAX pour un e-commerce ou un compte qui a déjà au moins 30 conversions par mois et un suivi sain (sinon il dépense à
   l'aveugle) ; DEMAND_GEN (Discover, Gmail, YouTube) pour créer de la demande avec de belles images ; YOUTUBE (vidéo, par Demand Gen)
   seulement si l'entreprise a des vidéos YouTube (adresse ou identifiant ; ne jamais en inventer) ; DISPLAY en remarketing ou notoriété
   locale. Les règles de chaque type (textes, images, vidéos) : listCampaignPlans → elements_par_type, strategies_par_type.
   Images (types visuels) : suggestAdImages(url d'une page du site) puis importAdImage(url, format paysage / carre / portrait / logo) ;
   images du site ou fournies par l'utilisateur seulement ; l'identifiant rendu va dans visuel.images ou marque.logos.
   Audience (plan.audience) : pour Performance Max c'est un SIGNAL (Google peut aller au-delà), pour Demand Gen / YouTube / Display un
   CIBLAGE. Le meilleur signal : listes du compte (visiteurs, clients : listAdsAudienceSegments kind=listes), puis audience personnalisée
   (perso.mots = ce que les clients tapent, perso.urls = sites qu'ils visitent : concurrents, fournisseurs), puis centres d'intérêt
   (noms en anglais : chercher q=electric, construction…). Âge et sexe seulement si l'utilisateur le dit (B2B : jamais deviner).
   Performance Max : themes par groupe (thèmes de recherche, ce que tapent les clients, 25 au plus).
   Shopping (e-commerce) : listMerchantAccounts ; plan.shopping.merchant_id parmi les comptes reliés, feed_label (souvent FR).
   SHOPPING standard = enchère au clic (MANUAL_CPC ou MAXIMIZE_CLICKS, cpc_max) sur tous les produits ; PERFORMANCE_MAX + shopping
   = fiches produits en plus des annonces (MAXIMIZE_CONVERSION_VALUE avec un suivi des ventes) ; un groupe sans textes ni images y
   diffuse seulement les fiches produits. Merchant introuvable chez Google = liaison à accepter dans Google Ads (le dire).
a. Économie : getAdsEconomics. E-commerce : panier et taux de conversion sont mesurés. Service sans vente en ligne : si verdict = incomplet ou des
   manquants, DEMANDER à l'utilisateur les chiffres (montant moyen d'une vente, marge, part des contacts qui deviennent devis, part des devis
   signés, contacts traitables par mois, budget maximal) puis setAdsEconomics avec SES réponses ; ne jamais inventer un chiffre. En retenir
   cpa_cible, cpc_max, budget_test et la capacité de l'équipe.
b. Mesure : getAdsConversionTracking. Sans action de conversion de contact active, partir sur MAXIMIZE_CLICKS avec cpc_max (au plus celui de
   la fiche) et dire à l'utilisateur de créer le suivi ; MAXIMIZE_CONVERSIONS (cpa_cible facultatif) seulement si le suivi est sain.
c. Zone : findAdsLocations (département, villes) ou rayon autour de l'adresse de la fiche ; presence_seulement=true pour un service local.
d. Demande : getCampaignKeywordIdeas avec location_id. Un groupe par service ou intention (5 à 20 mots-clés en expression ou exacte), avec la
   page du site qui y répond (listPages / getPage, ou buildAdsAssetsFromSite quoi=annonce pour un brouillon tiré de la page). En local B2B,
   les volumes sont faibles (« 10 » = moins de 10) : élargir la zone ou les services plutôt que conclure « pas de demande ».
e. Annonces : 8 à 15 titres de 30 caractères au plus (sans « ! », sans téléphone, la ville ou le département dans 2 ou 3 titres, les mots-clés
   du groupe dans 2 titres au moins), 3 ou 4 descriptions de 90 au plus, faits vérifiables seulement (rien d'inventé : certifications, délais,
   prix viennent du site ou de l'utilisateur). Éléments : 4 liens annexes, accroches, téléphone de la fiche. Mots-clés exclus : emploi,
   formation, gratuit, salaire… selon le métier. Horaires : ceux de la fiche si les appels comptent.
f. createCampaignPlan (notes = raisonnement et hypothèses) ; lire controles et estimation (getCampaignPlan) : corriger chaque bloquant avec
   updateCampaignPlan, puis checkCampaignPlan (vérification par Google, rien n'est créé). verdict volume_insuffisant ou non_viable : le dire
   et proposer une autre approche plutôt que créer quand même.
g. Présenter à l'utilisateur : lien du plan, budget, zones, groupes, estimation (clics, contacts par mois, CPA estimé face à la cible) et les
   avertissements. Sur son accord : createCampaignFromPlan (créée EN PAUSE, rien n'est dépensé, annulable par undoAdsAction), ou
   submitCampaignPlan s'il veut valider dans GPSEM. La mise en ligne est une décision à part de l'utilisateur : addAdsProposals type
   reprise_campagne puis decideAdsProposals / applyAdsProposals sur sa demande explicite, ou lui-même dans Google Ads.`],
  ['seo', `Veille et tendances : getTrendingTopics (sujets en hausse pour le site, par cluster) pour proposer des contenus d'actualité ;
analyzeExternalContent(url) pour juger si une page externe (concurrent, actualité) a du sens pour le site (sujet, angle, mots-clés, pertinence),
puis addExternalContentIdea (idée seule) ou writeFromExternalContent (lance la rédaction : demander confirmation) ; listWatchedTopics,
watchTopic, refreshTopicInsights, unwatchTopic pour la veille récurrente.

Recherche et enrichissement de contenu (gratuit, sans Google) : getTopicIdeas pour des sujets que le site ne traite pas encore ;
findEnrichmentSources(url ou sujet) pour étayer une page : Wikipedia et ses sources, publications, presse récente dans la langue du site et
internationale, pages officielles, vidéos, images libres, chacune avec sa pertinence, le passage qu'elle étaye et les chiffres absents du
contenu. searchWeb(q, type) pour une recherche ciblée sur le web : vérifier un fait ou un chiffre avant de l'écrire, trouver la page
officielle à citer (type=web, résultats type_source officiel / scientifique en premier), l'actualité récente (type=actualite, periode=month),
des études (type=science, requête en anglais), une vidéo ou une image libre (citer l'auteur, vérifier la licence sur sa page). Opérateurs
acceptés : site:domaine, "expression exacte". searchWeb n'est pas la page de résultats Google : ne jamais en déduire des positions.
Citer chaque source utilisée par son URL ; ne jamais présenter un résultat de recherche comme vérifié sans l'avoir lu.`],
  ['socle', `Justifier les recommandations : searchKnowledge cherche dans la documentation Google Search Central (en français) ; citer l'URL de la source.
Les actions d'audit et les rapports de problèmes Screaming Frog portent déjà leurs references.`],
  ['seo', `Éditeurs de contenu — le format du contenu dépend de l'éditeur de la page. Lire getPage (content=1) AVANT toute modification de contenu : le champ
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
être réimportée (pullPageFromCms) avant d'être retravaillée ici : sinon le prochain envoi de GPSEM écrase cette modification.`],
  ['socle', `Tracer chaque modification dans l'historique (addSiteHistorique) : c'est ce qui permet à GPSEM de mesurer l'effet des changements sur le trafic.
Lire d'abord getHistoriqueCodes et choisir le code le plus précis de la cible (100 site, 300 page, 310 catégorie, 320 archive) ; sinon le code générique
(100-09-001, 300-09-001, 310-09-001, 320-09-001) avec une description claire et l'avant / après dans details. updatePage et createPage écrivent leur historique eux-mêmes.`],
  ['seo', `Maillage interne — chaque lien ajouté doit être tracé, page par page : addSiteHistorique code=300-02-003, page_id = la page qui REÇOIT le lien,
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
Terminer chaque catégorie par une synthèse (updateOpquastCategory comment). Toutes les réponses restent modifiables dans GPSEM (lien renvoyé).`],
  ['netlinking', `Achat de backlinks (MyBack.link) : lire d'abord getMybacklinkStatus (achat autorisé, plafonds, dépense du mois, crédit, coût des options, ancres déjà utilisées),
choisir les pages cibles à partir des données GPSEM (pages performantes fragilisées, mots-clés en page 2, backlinks perdus), puis présenter la commande
(URL, mots-clés, nombre d'articles, options) et n'appeler orderBacklinks qu'après un accord explicite : c'est un achat réel.`],
  ['socle', `Actions à effet réel (demander confirmation à l'utilisateur avant) : orderBacklinks (achat), requestIndexing (API Indexing de Google, quota), runIndexTests sur beaucoup de pages (quota Search Console), writeFromExternalContent (rédaction), launchScreamingFrogCrawl (charge le serveur de crawl), runLinkCorrection (modifie les contenus et les renvoie au CMS), createSite (consomme le quota), createPage / updatePage avec push_to_cms, pushPageToCms, syncSite,
createContent / writeContentIdea (rédaction automatique), createAuditReport, updateCompanyInfo, updateSiteSettings, updateContentEditors, updateLegalNotice,
updatePage avec editor=elementor ou editor=classique (remplace la mise en page de la page).
Les traitements longs renvoient un task_id à suivre avec getTask, ou un statut pending à relire.`],
];

/** Consignes envoyées au client : sections des modules chargés, et l'état des modules pour que l'assistant sache quoi demander. */
function consignes() {
  const charges = Object.keys(MODULES).filter((m) => MODULES_ACTIFS.has(m));
  const absents = Object.keys(MODULES).filter((m) => !MODULES_ACTIFS.has(m) && (!PROFIL || PROFIL.permis.includes(m)));
  const parties = CONSIGNES.filter(([m]) => MODULES_ACTIFS.has(m)).map(([, t]) => t.trim());
  let entete = `${PROFIL ? `Serveur ${PROFIL.libelle}. ` : ''}Modules chargés : ${charges.join(', ')}.`;
  if (PROFIL) {
    entete += ` Une demande qui relève de l'autre profil (${PROFIL.nom === 'gpsem-seo' ? 'publicité : serveur gpsem-ads' : 'SEO : serveur gpsem-seo'}) se traite avec l'autre serveur GPSEM :`
      + ` le dire à l'utilisateur. Une réponse 403 scope_denied signifie que le jeton est limité à un autre périmètre.`;
  }
  if (absents.length) {
    entete += ` Non chargés : ${absents.map((m) => `${m} (${MODULES[m].libelle})`).join(' ; ')}. Pour une demande qui en relève, dire à l'utilisateur`
      + ` d'ajouter le module dans la variable GPSEM_MODULES de la configuration du serveur MCP GPSEM (ex. GPSEM_MODULES=${[...charges.filter((m) => m !== 'socle'), absents[0]].join(',')}).`;
  }
  if (DECOUVERTE) {
    entete += `\n\nMODE DÉCOUVERTE : les outils GPSEM ne sont pas listés un par un. findTools(q) cherche les outils par mots en français ou en anglais`
      + ` (ex. « pages en chute », « budget meta », « search console requêtes ») et renvoie nom, titre, module et arguments ; describeTool(names) donne`
      + ` le schéma complet ; callTool(name, arguments) appelle l'outil. Les outils cités dans ces consignes (getMe, listSites, querySearchConsole…)`
      + ` s'appellent directement par callTool ; describeTool seulement en cas de doute sur les arguments.`;
  }
  return `${parties[0]}\n\n${entete}\n\n${parties.slice(1).join('\n\n')}`;
}

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
      // Opérations d'entretien réservées (catalogue des spots…) : appelées en direct par leur module, pas des outils.
      if (op['x-mcp-ignorer']) continue;
      const tag = (op.tags || [])[0] || '';
      const parTag = Object.keys(MODULES).find((m) => MODULES[m].tags.includes(tag));
      // x-mcp-module : un module ou une liste (outil utile à plusieurs agents, ex. sea + campagnes)
      const declares = [].concat(op['x-mcp-module'] || []).filter((m) => MODULES[m]);
      const modules = declares.length ? declares : [MODULE_PAR_OUTIL[op.operationId]
        || MODULE_PAR_CHEMIN.find(([re]) => re.test(chemin))?.[1] || parTag || 'socle'];
      const module = modules.join('+');
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
        module,
        modules,
        tag,
        tagInconnu: module === 'socle' && !parTag && !declares.length && !MODULE_PAR_OUTIL[op.operationId],
        description: op.description || '',
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

/** Outils des modules chargés (GPSEM_MODULES). */
async function outilsActifs() {
  return (await outils()).filter((o) => o.modules.some((m) => MODULES_ACTIFS.has(m)));
}

/** Appel d'un outil GPSEM avec ses arguments, export en fichier compris ; renvoie le résultat MCP. */
async function lancerOutil(outil, args = {}) {
  try {
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
}

/** Outil absent des modules chargés : dire lequel l'apporte plutôt que « inconnu ». */
async function outilIntrouvable(nom) {
  const ailleurs = (await outils()).find((o) => o.definition.name === nom);
  if (ailleurs) {
    return `L'outil ${nom} appartient au module « ${ailleurs.modules.join(' » ou « ')} », non chargé. Demander à l'utilisateur d'ajouter ${ailleurs.modules[0]} `
      + `dans GPSEM_MODULES (configuration du serveur MCP GPSEM, modules chargés : ${[...MODULES_ACTIFS].join(', ')}).`;
  }
  return `Outil inconnu : ${nom}.${DECOUVERTE ? ' Chercher le bon nom avec findTools.' : ''}`;
}

// ---- Mode découverte : trois outils au lieu de la liste complète ----

const MOTS_VIDES = new Set(('de du des la le les un une et ou en sur par pour au aux a l d dans avec sans est qui que quoi mon ma mes son sa ses '
  + 'the of for to in on and or by with a an is my get list').split(' '));

function normaliser(t) {
  return String(t || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function mots(t) {
  return normaliser(t).split(/[^a-z0-9]+/).filter((m) => m.length > 1 && !MOTS_VIDES.has(m));
}

let indexRecherche = null;
async function index() {
  if (indexRecherche) return indexRecherche;
  indexRecherche = (await outilsActifs()).map((o) => ({
    outil: o,
    champs: [
      [new Set(mots(o.definition.name)), 3],
      [new Set(mots(o.definition.title)), 2.5],
      [new Set(mots(`${o.chemin} ${o.tag} ${o.module}`)), 1.5],
      [new Set(mots(o.description)), 1],
    ],
  }));
  return indexRecherche;
}

/** Score d'un outil pour une requête : mot exact, ou même racine (début commun), pondéré par le champ. */
function score(entree, termes) {
  let total = 0;
  let trouves = 0;
  for (const t of termes) {
    const racine = t.slice(0, Math.max(4, t.length - 2));
    let meilleur = 0;
    for (const [ens, poids] of entree.champs) {
      if (ens.has(t)) meilleur = Math.max(meilleur, poids);
      else if (racine.length >= 4) {
        for (const m of ens) if (m.startsWith(racine) || (m.length >= 4 && t.startsWith(m))) { meilleur = Math.max(meilleur, poids * 0.6); break; }
      }
    }
    if (meilleur) trouves += 1;
    total += meilleur;
  }
  return trouves ? total * (trouves / termes.length) : 0;
}

function fiche(o) {
  const props = o.definition.inputSchema.properties || {};
  const requis = o.definition.inputSchema.required || [];
  const desc = o.description.length > 260 ? `${o.description.slice(0, 260)}…` : o.description;
  return {
    name: o.definition.name,
    titre: o.definition.title,
    module: o.module,
    lecture: o.methode === 'get',
    requis,
    facultatifs: Object.keys(props).filter((k) => !requis.includes(k)),
    ...(desc ? { description: desc } : {}),
  };
}

const OUTILS_DECOUVERTE = [
  {
    name: 'findTools',
    title: 'Chercher un outil GPSEM',
    description: `Cherche parmi les outils GPSEM des modules chargés (${[...MODULES_ACTIFS].join(', ')}) : mots en français ou en anglais`
      + ' (ex. « pages en chute », « budget meta », « search console requêtes », « avis établissement »). Renvoie nom, titre, module, lecture'
      + ' seule ou écriture, arguments requis et facultatifs. Sans q : la liste des noms d\'un module (module=…).',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Ce que l\'outil doit faire, en quelques mots.' },
        module: { type: 'string', enum: [...MODULES_ACTIFS], description: 'Limiter à un module.' },
        lecture_seule: { type: 'boolean', description: 'true : seulement les outils qui ne modifient rien.' },
        limit: { type: 'integer', default: 12, minimum: 1, maximum: 50 },
      },
    },
    annotations: { title: 'Chercher un outil GPSEM', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'describeTool',
    title: 'Schéma d\'un outil GPSEM',
    description: 'Description complète et schéma des arguments (JSON Schema) d\'un ou plusieurs outils GPSEM, avant callTool.',
    inputSchema: {
      type: 'object',
      properties: { names: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Noms d\'outils (findTools → name).' } },
      required: ['names'],
    },
    annotations: { title: 'Schéma d\'un outil GPSEM', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'callTool',
    title: 'Appeler un outil GPSEM',
    description: 'Appelle un outil GPSEM par son nom avec ses arguments (mêmes arguments que l\'outil, dont siteId, limit, page'
      + `${EXPORT_DIR ? ', enregistrer_sous, toutes_les_pages' : ''}). Les outils d'écriture modifient réellement le compte : mêmes précautions que dans les consignes.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nom de l\'outil (ex. getMe, listSites, querySearchConsole).' },
        arguments: { type: 'object', additionalProperties: true, description: 'Arguments de l\'outil.' },
      },
      required: ['name'],
    },
    annotations: { title: 'Appeler un outil GPSEM', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

async function decouvrir(nom, args = {}) {
  const texte = (x) => ({ content: [{ type: 'text', text: typeof x === 'string' ? x : JSON.stringify(x, null, 1) }] });
  if (nom === 'findTools') {
    const limit = Math.min(50, Math.max(1, Math.floor(Number(args.limit)) || 12));
    let entrees = await index();
    if (args.module) entrees = entrees.filter((e) => e.outil.modules.includes(args.module));
    if (args.lecture_seule === true || args.lecture_seule === 'true') entrees = entrees.filter((e) => e.outil.methode === 'get');
    const termes = mots(args.q);
    if (!termes.length) {
      if (!args.module) {
        const parModule = {};
        for (const e of entrees) for (const m of e.outil.modules) parModule[m] = (parModule[m] || 0) + 1;
        return texte({ consigne: 'Donner q (ce que l\'outil doit faire) ou module pour la liste des noms.', outils_par_module: parModule });
      }
      return texte({ module: args.module, total: entrees.length, outils: entrees.map((e) => `${e.outil.definition.name} — ${e.outil.definition.title}`) });
    }
    const tries = entrees.map((e) => ({ e, s: score(e, termes) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    // Les correspondances lointaines (un seul mot partagé avec la description) sont écartées quand de bien meilleures existent
    const classes = tries.filter((x) => x.s >= (tries[0]?.s || 0) * 0.3);
    if (!classes.length) {
      return texte(`Aucun outil trouvé pour « ${args.q} » dans les modules chargés (${[...MODULES_ACTIFS].join(', ')}). Essayer d'autres mots,`
        + ' ou findTools sans q avec module=… pour la liste.');
    }
    return texte({ q: args.q, trouves: classes.length, outils: classes.slice(0, limit).map((x) => fiche(x.e.outil)) });
  }
  if (nom === 'describeTool') {
    const noms = [].concat(args.names ?? args.name ?? []).map(String).slice(0, 10);
    if (!noms.length) return { isError: true, ...texte('names attendu : liste de noms d\'outils (findTools → name).') };
    const actifs = await outilsActifs();
    const sorties = [];
    for (const n of noms) {
      const o = actifs.find((x) => x.definition.name === n);
      sorties.push(o ? { ...o.definition, module: o.module } : { name: n, erreur: await outilIntrouvable(n) });
    }
    return texte(sorties);
  }
  if (nom === 'callTool') {
    const o = (await outilsActifs()).find((x) => x.definition.name === args.name);
    if (!o) return { isError: true, ...texte(await outilIntrouvable(args.name)) };
    let a = args.arguments ?? {};
    if (typeof a === 'string') {
      try { a = JSON.parse(a); } catch { return { isError: true, ...texte('arguments doit être un objet JSON.') }; }
    }
    return lancerOutil(o, a);
  }
  return { isError: true, ...texte(`Outil inconnu : ${nom}. Outils du mode découverte : findTools, describeTool, callTool.`) };
}

async function main() {
  if (process.argv.includes('--list-tools')) {
    const tous = await outils();
    for (const o of tous.filter((x) => x.modules.some((m) => MODULES_ACTIFS.has(m)))) {
      console.log(`${o.definition.name.padEnd(32)} ${o.module.padEnd(11)} ${o.methode.toUpperCase().padEnd(6)} ${o.chemin}`);
    }
    console.log('\nModule       outils   ≈ tokens   chargé');
    for (const m of Object.keys(MODULES)) {
      const liste = tous.filter((o) => o.modules.includes(m));
      const poids = Math.round(liste.reduce((s, o) => s + JSON.stringify(o.definition).length, 0) / 3.5);
      console.log(`${m.padEnd(12)} ${String(liste.length).padStart(6)} ${String(poids).padStart(10)}   ${MODULES_ACTIFS.has(m) ? 'oui' : 'non'}`);
    }
    const c = consignes();
    console.log(`consignes : ${c.length} caractères (≈ ${Math.round(c.length / 3.5)} tokens, hors résumé des rapports)`
      + `${DECOUVERTE ? ' ; mode découverte : 3 outils envoyés' : ''}`);
    const inconnus = [...new Set(tous.filter((o) => o.tagInconnu).map((o) => o.tag || '(sans tag)'))];
    if (inconnus.length) console.log(`\nATTENTION tags sans module (rangés dans le socle) : ${inconnus.join(', ')} — les ajouter à MODULES.`);
    return;
  }
  if (process.argv.includes('--consignes')) {
    console.log(consignes());
    return;
  }
  if (!TOKEN) {
    console.error('GPSEM_API_TOKEN manquant : créez un token dans GPSEM (Entreprise → API GPSEM) et passez-le en variable d\'environnement.');
    process.exit(1);
  }

  const server = new Server({ name: PROFIL ? PROFIL.nom : 'gpsem', version: VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: consignes() + (await resumeRapports()) });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: DECOUVERTE ? OUTILS_DECOUVERTE.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }))
      : (await outilsActifs()).map((o) => o.definition),
  }));

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
    const nom = requete.params.name;
    const args = requete.params.arguments || {};
    if (DECOUVERTE) {
      try {
        return await decouvrir(nom, args);
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `Échec : ${e.message}` }] };
      }
    }
    const outil = (await outilsActifs()).find((o) => o.definition.name === nom);
    if (!outil) return { isError: true, content: [{ type: 'text', text: await outilIntrouvable(nom) }] };
    return lancerOutil(outil, args);
  });

  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
