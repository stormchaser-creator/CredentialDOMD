// CPT Code Search Engine
// Lazy-loads CPT data on first search, builds in-memory index for fast lookup

let cptData = null;
let searchIndex = null;

async function ensureLoaded() {
  if (cptData) return;
  const mod = await import("../constants/cpt/index.js");
  cptData = mod.CPT_CODES;
  searchIndex = buildSearchIndex(cptData);
}

function buildSearchIndex(codes) {
  return codes.map(c => {
    const parts = [
      c.code,
      c.shortDesc || "",
      c.fullDesc || "",
      ...(c.synonyms || []),
      ...(c.keywords || []),
      c.category || "",
      c.subcategory || "",
    ];
    const searchText = parts.join(" ").toLowerCase();
    const tokens = searchText.split(/\s+/).filter(t => t.length > 1);
    return { code: c.code, ref: c, searchText, tokens };
  });
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
}

export async function searchCPT(query, { category = null, limit = 15 } = {}) {
  await ensureLoaded();

  const q = query.trim().toLowerCase();
  if (!q) return { results: [], confidence: "none" };

  const isCodeSearch = /^\d{1,5}$/.test(q);
  const queryTokens = q.split(/\s+/).filter(t => t.length > 1);

  const scored = [];

  for (const entry of searchIndex) {
    if (category && entry.ref.category !== category) continue;

    let score = 0;

    // Strategy 1: Code match
    if (isCodeSearch) {
      if (entry.code === q) {
        score += 100;
      } else if (entry.code.startsWith(q)) {
        score += 70 + (5 - Math.abs(entry.code.length - q.length));
      }
    }

    // Strategy 2: Multi-token text matching
    if (queryTokens.length > 0) {
      let matchedTokens = 0;

      for (const qt of queryTokens) {
        if (entry.searchText.includes(qt)) {
          score += 10;
          matchedTokens++;

          // Bonus: synonym match
          if (entry.ref.synonyms?.some(s => s.toLowerCase().includes(qt))) {
            score += 5;
          }
          // Bonus: keyword exact match
          if (entry.ref.keywords?.some(k => k.toLowerCase() === qt)) {
            score += 8;
          }
          // Bonus: code contains token
          if (entry.code.includes(qt)) {
            score += 15;
          }
          // Bonus: full description starts with query
          if (entry.ref.fullDesc?.toLowerCase().startsWith(q)) {
            score += 20;
          }
        } else if (qt.length > 3) {
          // Fuzzy: check for close matches in tokens
          const fuzzy = entry.tokens.some(t => t.length > 3 && levenshtein(qt, t) <= 1);
          if (fuzzy) {
            score += 4;
            matchedTokens++;
          }
        }
      }

      // Coverage bonus: proportion of query tokens matched
      const coverage = matchedTokens / queryTokens.length;
      score *= (0.3 + 0.7 * coverage);

      // Bonus for curated codes (they have synonyms = more reliable matches)
      if (entry.ref.synonyms && score > 0) score += 3;
    }

    if (score > 0) {
      scored.push({ ...entry.ref, score, _matchType: isCodeSearch && entry.code.startsWith(q) ? "code" : "text" });
    }
  }

  // Sort by score descending, then by code ascending for ties
  scored.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));

  const results = scored.slice(0, limit);

  // Confidence assessment
  const topScore = results[0]?.score || 0;
  let confidence;
  if (topScore >= 40) confidence = "high";
  else if (topScore >= 15) confidence = "medium";
  else if (topScore > 0) confidence = "low";
  else confidence = "none";

  return { results, confidence, query: q };
}

export async function getCPTByCode(code) {
  await ensureLoaded();
  return cptData.find(c => c.code === code) || null;
}

export async function getCPTCategories() {
  await ensureLoaded();
  return [...new Set(cptData.map(c => c.category).filter(Boolean))].sort();
}
