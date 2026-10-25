/**
 * WYA AI-Powered Recommendations
 * Uses customer activity patterns + Gemini for personalized vendor suggestions
 * (c) Universoul LLC | Santa Barbara, CA
 */
const http = require('http');

// Recommendation categories
const RECOMMENDATION_TYPES = {
  NEARBY: 'nearby',
  POPULAR: 'popular',
  TRENDING: 'trending',
  PERSONALIZED: 'personalized',
  NEW: 'new',
  REORDER: 'reorder',
};

/**
 * Generate AI-powered recommendations for a customer
 * @param {Object} db - SQLite database instance
 * @param {string|null} customerId - Customer ID (null for anonymous)
 * @param {number} lat - Customer latitude
 * @param {number} lng - Customer longitude
 * @param {number} limit - Max recommendations
 * @returns {Promise<Array>} Ranked vendor recommendations
 */
async function getRecommendations(db, customerId, lat, lng, limit = 10) {
  const recommendations = [];
  const seen = new Set();

  try {
    // 1. Get all active vendors with GPS
    const vendors = db.prepare(`
      SELECT
        v.id, v.name, v.category, v.lat, v.lng, v.photo_url, v.description,
        v.avg_rating, v.review_count, v.estimated_prep_minutes, v.accepts_orders,
        v.delivery_enabled, v.is_open, v.is_founding_vendor, v.created_at,
        COALESCE(o.order_count, 0) as recent_orders,
        COALESCE(f.follower_count, 0) as followers
      FROM vendors v
      LEFT JOIN (
        SELECT vendor_id, COUNT(*) as order_count
        FROM orders
        WHERE created_at >= datetime('now', '-7 days')
        AND status NOT IN ('cancelled')
        GROUP BY vendor_id
      ) o ON o.vendor_id = v.id
      LEFT JOIN (
        SELECT vendor_id, COUNT(*) as follower_count
        FROM vendor_followers
        WHERE active = 1
        GROUP BY vendor_id
      ) f ON f.vendor_id = v.id
      WHERE v.lat IS NOT NULL AND v.lng IS NOT NULL
    `).all();

    // 2. Calculate distance and score for each vendor
    const scored = vendors.map(v => {
      const distance = haversine(lat, lng, v.lat, v.lng);
      const score = calculateScore(v, distance, customerId, db);
      return { ...v, distance, score };
    });

    // 3. Sort by score and filter
    scored.sort((a, b) => b.score - a.score);

    // 4. Add recommendation reasons
    for (const vendor of scored.slice(0, limit)) {
      if (seen.has(vendor.id)) continue;
      seen.add(vendor.id);

      const reason = getRecommendationReason(vendor, customerId, db);
      recommendations.push({
        ...vendor,
        recommendation_type: reason.type,
        recommendation_reason: reason.text,
      });
    }

    // 5. If customer exists, try to get AI-enhanced recommendations
    if (customerId && recommendations.length > 0) {
      await enhanceWithAI(recommendations, customerId, db);
    }

  } catch (err) {
    console.error('[WYA-AI] Recommendation error:', err.message);
  }

  return recommendations;
}

/**
 * Calculate vendor score for ranking
 */
function calculateScore(vendor, distance, customerId, db) {
  let score = 0;

  // Distance score (inverse, max 30 points)
  const distanceScore = Math.max(0, 30 - distance * 2);
  score += distanceScore;

  // Rating score (max 25 points)
  if (vendor.avg_rating) {
    score += vendor.avg_rating * 5;
  }

  // Popularity score (max 20 points)
  const popularityScore = Math.min(20,
    (vendor.recent_orders * 2) +
    (vendor.followers * 0.5) +
    (vendor.review_count * 0.3)
  );
  score += popularityScore;

  // Open now bonus (15 points)
  if (vendor.is_open) {
    score += 15;
  }

  // Accepts orders bonus (10 points)
  if (vendor.accepts_orders) {
    score += 10;
  }

  // Founding vendor bonus (5 points - support locals)
  if (vendor.is_founding_vendor) {
    score += 5;
  }

  // New vendor boost (for vendors < 30 days old)
  const createdDaysAgo = (Date.now() - new Date(vendor.created_at).getTime()) / (1000 * 60 * 60 * 24);
  if (createdDaysAgo < 30) {
    score += 10 * (1 - createdDaysAgo / 30);
  }

  // Personalization boost if customer has history
  if (customerId) {
    const pastOrders = db.prepare(`
      SELECT COUNT(*) as c FROM orders
      WHERE customer_id = ? AND vendor_id = ? AND status = 'completed'
    `).get(customerId, vendor.id)?.c || 0;

    if (pastOrders > 0) {
      score += 10 + Math.min(10, pastOrders * 2); // Reorder boost
    }

    // Check if in favorites
    const isFavorite = db.prepare(`
      SELECT 1 FROM favorites WHERE customer_id = ? AND vendor_id = ?
    `).get(customerId, vendor.id);

    if (isFavorite) {
      score += 15;
    }
  }

  return Math.round(score * 100) / 100;
}

/**
 * Generate human-readable recommendation reason
 */
function getRecommendationReason(vendor, customerId, db) {
  if (customerId) {
    // Check for reorder
    const lastOrder = db.prepare(`
      SELECT created_at FROM orders
      WHERE customer_id = ? AND vendor_id = ? AND status = 'completed'
      ORDER BY created_at DESC LIMIT 1
    `).get(customerId, vendor.id);

    if (lastOrder) {
      return {
        type: RECOMMENDATION_TYPES.REORDER,
        text: 'You ordered from here before',
      };
    }

    // Check if favorite
    const isFavorite = db.prepare(`
      SELECT 1 FROM favorites WHERE customer_id = ? AND vendor_id = ?
    `).get(customerId, vendor.id);

    if (isFavorite) {
      return {
        type: RECOMMENDATION_TYPES.PERSONALIZED,
        text: 'One of your favorites',
      };
    }
  }

  // Open and nearby
  if (vendor.is_open && vendor.distance < 2) {
    return {
      type: RECOMMENDATION_TYPES.NEARBY,
      text: `Open now, ${vendor.distance.toFixed(1)} mi away`,
    };
  }

  // Popular
  if (vendor.recent_orders > 10 || vendor.followers > 50) {
    return {
      type: RECOMMENDATION_TYPES.POPULAR,
      text: 'Popular in your area',
    };
  }

  // Trending (high recent activity)
  if (vendor.recent_orders > 5) {
    return {
      type: RECOMMENDATION_TYPES.TRENDING,
      text: 'Trending this week',
    };
  }

  // New vendor
  const createdDaysAgo = (Date.now() - new Date(vendor.created_at).getTime()) / (1000 * 60 * 60 * 24);
  if (createdDaysAgo < 30) {
    return {
      type: RECOMMENDATION_TYPES.NEW,
      text: 'New to WYA',
    };
  }

  // Default
  return {
    type: RECOMMENDATION_TYPES.NEARBY,
    text: `${vendor.distance.toFixed(1)} mi away`,
  };
}

/**
 * Enhance recommendations with AI-generated insights
 */
async function enhanceWithAI(recommendations, customerId, db) {
  try {
    // Get customer's order history for context
    const orderHistory = db.prepare(`
      SELECT v.category, COUNT(*) as c
      FROM orders o
      JOIN vendors v ON v.id = o.vendor_id
      WHERE o.customer_id = ? AND o.status = 'completed'
      GROUP BY v.category
      ORDER BY c DESC
      LIMIT 5
    `).all(customerId);

    if (orderHistory.length === 0) return;

    // Build preference profile
    const preferences = orderHistory.map(o => o.category).join(', ');

    // Call Gemini via Soul AI router (if available)
    const prompt = `Based on a customer who frequently orders ${preferences}, provide a one-sentence recommendation reason for "${recommendations[0].name}" (${recommendations[0].category}). Keep it under 50 characters, friendly and compelling.`;

    const response = await callAI(prompt);
    if (response && response.length < 60) {
      recommendations[0].ai_reason = response;
    }

  } catch (err) {
    console.error('[WYA-AI] Enhancement error:', err.message);
    // Fail silently - AI enhancement is optional
  }
}

/**
 * Call AI service (Gemini via tenant gateway)
 */
function callAI(prompt) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      message: prompt,
      systemPrompt: 'You are a helpful food recommendation assistant. Be concise and friendly.',
      maxTokens: 50,
    });

    const req = http.request({
      hostname: '127.0.0.1',
      port: 3001,
      path: '/api/ai/quick',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result.response || result.message || null);
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

/**
 * Haversine distance formula
 */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg) {
  return deg * (Math.PI / 180);
}

module.exports = {
  getRecommendations,
  RECOMMENDATION_TYPES,
};
