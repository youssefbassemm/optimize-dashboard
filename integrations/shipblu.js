'use strict';

// ShipBlu integration stub — real implementation not yet deployed.
// The server requires this module at startup; these no-ops keep it from crashing.

async function testConnection(apiKey) {
  if (!apiKey) return false;
  try {
    const res = await fetch('https://app.shipblu.com/api/v1/orders/?limit=1', {
      headers: { Authorization: `Token ${apiKey}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function fullSync(brandId) {
  // Not implemented — ShipBlu sync is a future feature.
}

module.exports = { testConnection, fullSync };
