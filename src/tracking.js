#!/usr/bin/env node
// Serveur MCP « GPSEM Tracking » : audit des tags, du consentement et des conversions mesurées, plus le socle et les
// lectures utiles pour relier un tag cassé à ses effets (conversions Google Ads, régies face à GA4, GA4, attribution).
process.env.GPSEM_PROFIL = 'tracking';
await import('./index.js');
