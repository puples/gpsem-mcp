# GPSEM MCP

Serveur [MCP](https://modelcontextprotocol.io) de [GPSEM](https://app.gpsem.io) : il donne à un assistant IA (Claude, ChatGPT, Cursor, Windsurf…) l'accès à votre compte GPSEM.

- **Pages, catégories, archives (CPT)** : lister, lire la fiche complète d'une page (SEO, indexation, scores, historique, problèmes de crawl), créer, modifier.
- **Historique des modifications** : lire et ajouter des événements (site, page, catégorie, archive), dont chaque lien interne avec sa page source et sa date, pour mesurer l’effet de chaque changement sur le crawl, l’indexation et le trafic.
- **Search Console, GA4, Bing Webmaster, Merchant Center, YouTube** : interrogés en direct avec les connexions déjà faites dans GPSEM, sans rien reconnecter. Search Console et GA4 acceptent des requêtes libres (dimensions, métriques, filtres, périodes).
- **Audit SEO** : sections collectées à la demande ; rapports résultats, technique, complet ou Knowledge Graph, en aperçu, PDF et PowerPoint ; scores, plan d’action priorisé avec gain estimé, suivi des actions.
- **Outils GPSEM** : 60 tableaux et croisements (opportunités, concurrence Semrush, saisonnalité, motifs des non indexées, activité de Google, liens internes datés…) des écrans et de la boîte à outils, groupés par thème (indexation, contenus et pruning, mots-clés et Search Console, maillage, netlinking, analytics et conversions, planning éditorial).
- **Screaming Frog** : lancer un crawl, problèmes par catégorie, plan d'action, rapport par problème (avec la documentation Google), problèmes d'une page.
- **Audit Opquast** : créer un audit, parcourir les 240 règles par catégorie, y répondre (conforme / non conforme) avec un commentaire argumenté à partir du crawl et des pages, marquer les catégories hors périmètre, rédiger la synthèse de chaque catégorie.
- **Analyses** : suggestions de maillage interne, NavRank / ClickRank, mots-clés et analyse sémantique, cartographie sémantique du site.
- **Rédaction** : idées de contenu, rédaction automatique depuis une expression, une ou plusieurs URL (réécriture d'une page concurrente), un mot-clé.
- **Synchronisation CMS** : envoyer une page vers WordPress, réimporter une page, synchroniser tout le site.
- **Backlinks (MyBack.link)** : crédit, coût des options, ancres déjà utilisées, historique des commandes, commande de backlinks vers vos pages. L'achat via le MCP est désactivé par défaut : il s'active dans GPSEM, paramètres MyBack.link de l'entreprise, avec un plafond mensuel et un nombre maximal d'articles par commande.
- **Compte** : ajout de site (dans la limite de l'abonnement), coordonnées de l'entreprise, paramètres du site, mentions légales.

Les outils sont générés au démarrage depuis la spécification OpenAPI de l'API GPSEM : toute nouvelle route de l'API devient un outil, sans mise à jour du paquet.

## Installation

Il faut Node.js 18 ou plus et un **token API GPSEM** : dans GPSEM, menu utilisateur → *API & MCP*, ou fiche entreprise → onglet *API GPSEM* → *Créer un token*. Le token n'est affiché qu'une fois.

### Claude Code

```bash
claude mcp add gpsem -e GPSEM_API_TOKEN=gpsem_votre_token -- npx -y github:puples/gpsem-mcp
```

### Claude Desktop, Cursor, Windsurf et autres clients MCP

Dans le fichier de configuration MCP du client (`claude_desktop_config.json`, `.cursor/mcp.json`…) :

```json
{
  "mcpServers": {
    "gpsem": {
      "command": "npx",
      "args": ["-y", "github:puples/gpsem-mcp"],
      "env": { "GPSEM_API_TOKEN": "gpsem_votre_token" }
    }
  }
}
```

### Variables d'environnement

| Variable | | Rôle |
|---|---|---|
| `GPSEM_API_TOKEN` | obligatoire | Token `gpsem_…` de l'entreprise |
| `GPSEM_SITE_ID` | facultatif | Site par défaut (ID encodé) : plus besoin de préciser `siteId` |
| `GPSEM_API_URL` | facultatif | Défaut `https://app.gpsem.io/api/v1/external` |
| `GPSEM_MAX_CHARS` | facultatif | Taille maximale d'une réponse transmise à l'assistant (défaut 60 000 caractères) |

Le token reste sur votre poste : le serveur MCP appelle directement l'API GPSEM, sans intermédiaire.

## Exemples de demandes

- « Quels sont les 10 chantiers SEO prioritaires de mon site, avec leur gain estimé ? »
- « Liste les pages qui ont beaucoup d'impressions mais un click rank faible et propose de nouvelles balises title. »
- « Corrige la meta description des pages sans meta, envoie-les sur WordPress et note-le dans l'historique. »
- « Quelles pages sont hors sujet d'après la cartographie sémantique ? »
- « Rédige un article à partir de cette page concurrente : https://… »
- « Les mentions légales de mon site sont-elles complètes ? Complète l'hébergeur et le directeur de la publication. »
- « Crée un nouveau site pour https://exemple.fr si mon abonnement le permet. »
- « Lance un crawl Screaming Frog, puis fais l'audit Opquast du site à partir du crawl, avec un commentaire pour chaque règle. »
- « Quelles pages mériteraient des backlinks ce mois-ci ? Prépare une commande MyBack.link de 3 articles, je valide avant. »

## Catalogue des rapports

À la connexion, le serveur envoie à l'assistant la liste de tous les rapports disponibles, dans ses consignes : chaque section / question de l'audit complet (par chapitre), Screaming Frog, NavRank / ClickRank, Opquast, sources de données, analyses, avec l'outil et les arguments à utiliser. Avec `GPSEM_SITE_ID`, la liste est celle du site : rapports indisponibles signalés (source non connectée, pas de crawl…) et problèmes Screaming Frog relevés au dernier crawl.

Le catalogue complet est aussi exposé :
- en outils : `listReports` (général) et `listReportsForSite` ;
- en ressources MCP : `gpsem://rapports` et `gpsem://sites/{siteId}/rapports`.

## Bonnes pratiques intégrées

- **Données par étapes** : les grosses réponses sont résumées ou paginées (sections d'audit : `data_index` puis `data=` / `bloc=` ; cartographie : `cluster=`, `q=`, `page_id=` ; listes : `limit`, `page`). Au-delà de `GPSEM_MAX_CHARS`, la réponse est tronquée avec une indication pour affiner la demande.
- **Historique** : l'assistant lit `getHistoriqueCodes` et choisit le code le plus précis, ou le code générique de la cible (`100-09-001` site, `300-09-001` page, `310-09-001` catégorie, `320-09-001` archive). Les événements ajoutés par le MCP portent la source `mcp`.
- **Actions à effet réel** (publication CMS, rédaction automatique, création de site, génération d'audit, modification du compte) : signalées aux clients MCP comme non en lecture seule ; l'assistant est invité à demander confirmation.

## Vérifier l'installation

```bash
npx -y github:puples/gpsem-mcp --list-tools
```

Affiche la liste des outils (ne nécessite pas de token).

Documentation de l'API : [app.gpsem.io/api/v1/external/docs](https://app.gpsem.io/api/v1/external/docs).

## Licence

MIT
