export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Query manquante' });

  const SERP_KEY   = process.env.SERP_API_KEY;
  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  const AMZN_TAG   = process.env.AMAZON_TAG;

  try {
    // ── Étape 1 : SerpAPI Google Shopping ──────────────────────────────
    const serpParams = new URLSearchParams({
      engine: 'google_shopping',
      q: query,
      gl: 'fr',
      hl: 'fr',
      api_key: SERP_KEY,
    });

    const serpResp = await fetch(`https://serpapi.com/search.json?${serpParams}`);
    const serpData = await serpResp.json();

    const raw = (serpData.shopping_results || []).slice(0, 10);

    if (!raw.length) {
      return res.status(200).json({
        summary: "Aucun produit trouvé pour cette recherche. Essaie avec d'autres mots-clés.",
        products: []
      });
    }

    // Ajoute le tag affilié Amazon sur les liens Amazon
    const products = raw.map(p => {
      let url = p.link || p.product_link || '#';
      if (url.includes('amazon.fr') || url.includes('amazon.com')) {
        try {
          const u = new URL(url);
          u.searchParams.set('tag', AMZN_TAG);
          url = u.toString();
        } catch {}
      }
      return {
        name:    p.title || 'Produit',
        price:   p.price || '?',
        shop:    p.source || 'Google Shopping',
        url,
        image:   p.thumbnail || null,
        rating:  p.rating || null,
        reviews: p.reviews || null,
      };
    });

    // ── Étape 2 : Claude analyse et classe ─────────────────────────────
    const productList = products.map((p, i) =>
      `${i+1}. ${p.name} — ${p.price} — ${p.shop} — Note: ${p.rating || 'N/A'} (${p.reviews || '?'} avis)`
    ).join('\n');

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        system: `Tu es un personal shopper expert. Analyse la demande et classe les produits.
Retourne UNIQUEMENT un JSON valide sans markdown :
{
  "summary": "2-3 phrases : analyse de la demande + conseil principal",
  "ranking": [1, 3, 2, 5, 4]
}
Le ranking = numéros des produits (1-based) dans l'ordre de recommandation pour la demande.`,
        messages: [{
          role: 'user',
          content: `Demande : "${query}"\n\nProduits :\n${productList}`
        }]
      })
    });

    const claudeData = await claudeResp.json();
    const text = claudeData.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(clean);

    // ── Étape 3 : Reorder + réponse finale ─────────────────────────────
    const ranked = (analysis.ranking || products.map((_, i) => i + 1))
      .map(i => products[i - 1])
      .filter(Boolean)
      .map((p, i) => ({ ...p, best: i === 0 }));

    return res.status(200).json({
      summary: analysis.summary,
      products: ranked,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
