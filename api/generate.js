export const config = { maxDuration: 60 };

async function researchBrand(url) {
  const hostname = new URL(url).hostname.replace("www.", "");

  // Two-step: first fetch the page, then search for extra context
  // This gives Claude real colors, copy, and product names from the actual site
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 3000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: "user",
        content:
`You are a brand researcher and senior ad creative director. Follow these steps carefully:

STEP 1 — Read the website
Search for the homepage and key pages of: ${url}
Also search: "${hostname} brand colors" and "${hostname} products"
Extract from what you find:
- Exact brand colors (hex codes if possible, otherwise precise color names like "deep navy #1a2744" or "coral red #e8392a")
- Real product names, prices, and descriptions
- Actual taglines, slogans, and marketing copy used on the site
- Target demographic and brand personality
- Visual style (minimalist, bold, luxury, playful, etc.)

STEP 2 — Generate the ad
Using ONLY what you found (not generic guesses), create 1 high-converting Instagram/social ad concept.

The ad must follow this Alpecin-style template:
- Striking lifestyle hero shot: real person emotionally connected to the product
- Actual product shown prominently with correct branding
- Massive bold headline text in the REAL brand colors — like a billboard, punching out of the image
- CTA button in contrasting brand color
- Professional photography, dramatic studio lighting, cinematic quality

CRITICAL: The image_prompt must use the ACTUAL brand colors found on the site, ACTUAL product names, and reflect the REAL brand aesthetic — not generic stock photo vibes.

Return ONLY valid JSON, no markdown, no extra text:
{
  "brand_name": "exact brand name",
  "brand_summary": "2-3 sentences based on what you actually found",
  "brand_colors": ["#hexcode1", "#hexcode2"],
  "target_audience": "specific demographic",
  "ads": [
    {
      "concept": "short concept name",
      "headline": "bold headline 5 words max using real brand voice",
      "subheadline": "supporting line 8 words max",
      "cta": "CTA 3 words max",
      "image_prompt": "Extremely detailed Flux image generation prompt using REAL brand colors, REAL product names, REAL brand aesthetic. Describe: the person and their emotion, exact product placement, lighting setup, background, camera angle, mood. MUST include: massive bold typography with the headline text in [brand's actual primary color], oversized letters dominating the upper or lower third of the frame, billboard-style impact. End with: photorealistic, 4K, professional advertising photography, studio lighting, sharp focus, high dynamic range, bold impactful typography."
    }
  ]
}`
      }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  // Handle multi-turn tool use - Claude may need multiple rounds to search
  const textBlocks = data.content.filter(b => b.type === "text");
  const raw = textBlocks.map(b => b.text).join("");
  const clean = raw.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(clean);
  } catch (e) {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Failed to parse brand research: " + clean.slice(0, 300));
  }
}

async function startFlux(prompt) {
  const res = await fetch(
    "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          prompt,
          width: 832,
          height: 1040,
          num_outputs: 1,
          output_format: "jpg",
          output_quality: 90,
          num_inference_steps: 4,
        },
      }),
    }
  );
  const text = await res.text();
  console.log("Flux start:", res.status, text.slice(0, 300));
  if (!res.ok) throw new Error(`Flux failed ${res.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  if (data.error) throw new Error(`Flux error: ${data.error}`);
  return data.id;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing url" });

  try {
    console.log("Researching brand:", url);
    const brand = await researchBrand(url);
    console.log("Brand research done:", brand.brand_name, "colors:", brand.brand_colors);

    const pid = await startFlux(brand.ads[0].image_prompt);
    console.log("Flux prediction started:", pid);

    return res.status(200).json({ brand, predictionIds: [pid] });
  } catch (err) {
    console.error("Generate error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
