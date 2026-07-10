'use strict';

// Bosta integration stub — real implementation not yet deployed.

async function testConnection(apiKey) {
  if (!apiKey) return false;
  try {
    const res = await fetch('https://app.bosta.co/api/v2/deliveries?size=1', {
      headers: { Authorization: apiKey },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function fullSync(brandId) {
  // Not implemented — Bosta sync is a future feature.
}

module.exports = { testConnection, fullSync };
