'use strict';

// Meta (Facebook/Instagram) integration stub — real implementation not yet deployed.
// Exports all methods called by scheduler.js, routes/campaigns.js, routes/dashboard.js,
// and routes/meta_oauth.js so the server starts without crashing.

async function fullSync(brandId) {
  // Not implemented.
}

async function checkTokenExpiry() {
  // Not implemented.
}

function getCampaigns(brandId, period) {
  return [];
}

function getInstagram(brandId) {
  return null;
}

async function discover(brandId, longToken) {
  // Not implemented.
}

async function discoverIds(accessToken) {
  return {};
}

async function verifyToken(accessToken) {
  return { valid: false };
}

module.exports = { fullSync, checkTokenExpiry, getCampaigns, getInstagram, discover, discoverIds, verifyToken };
