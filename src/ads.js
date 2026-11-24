#!/usr/bin/env node
// Serveur MCP « GPSEM Ads » : conseil publicitaire et création de campagnes, plus le socle.
process.env.GPSEM_PROFIL = 'ads';
await import('./index.js');
