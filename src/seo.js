#!/usr/bin/env node
// Serveur MCP « GPSEM SEO » : modules SEO, netlinking (et SEO local sur demande), plus le socle.
process.env.GPSEM_PROFIL = 'seo';
await import('./index.js');
