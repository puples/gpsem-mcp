#!/usr/bin/env node
// Serveur MCP « GPSEM Netlinking » : spots de liens, achat de liens, liens suivis, plus le socle et les lectures
// Search Console utiles au choix des pages.
process.env.GPSEM_PROFIL = 'netlinking';
await import('./index.js');
