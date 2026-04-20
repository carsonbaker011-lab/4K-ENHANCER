export const config = { maxDuration: 60 };

async function researchBrand(url) {
  const hostname = new URL(url).hostname.replace("www.", "");

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

CRITICAL: The image_prompt must use the ACTUAL brand colors found on the site, ACTUAL product names, and reflect the REAL brand aesthetic.

Return ONLY valid JSON, no markdown, no extra text:
{
  "brand_name": "exact brand name",
  "brand_summary": "2-3 sentences based on what you actually found",
  "brand_colors": ["#hexcode1", "#hexcode2"],
  "target_audience": "specific demographic",
  "ads": [
    {
      "concept": "short concept name",
      "headline": "bold headline 3-5 words ALL CAPS",
      "subheadline": "supporting line 8 words max",
      "cta": "CTA 3 words max",
      "image_prompt": "FILL THIS WITH THE TEMPLATE BELOW — replace [BRAND COLOR], [PRODUCT NAME], [HEADLINE] with real values from the brand"
    }
  ]
}`
      }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const textBlocks = data.content.filter(b => b.type === "text");
  const raw = textBlocks.map(b => b.text).join("");
  const clean = raw.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(clean);
    // Inject the base prompt template with brand-specific details
    const ad = parsed.ads[0];
    const colors = parsed.brand_colors || [];
    const primaryColor = colors[0] || "brand primary color";
    const secondaryColor = colors[1] || "brand secondary color";

    ad.image_prompt = `Ultra-realistic, high-end commercial product advertisement for ${parsed.brand_name}, shot in a clean studio environment with dramatic lighting. The scene features the ${ad.concept} — a single ${parsed.brand_name} product (${ad.headline}) as the focal point, captured mid-motion with dynamic elements like splashing liquid, particles, or motion blur for energy and impact. Background is minimal and softly colored in ${secondaryColor} to contrast the subject.

Add large, bold, modern typography on the left side of the frame with the headline "${ad.headline}" in all caps, sans-serif, heavy weight, in ${primaryColor}. Keep text minimal but punchy. Include a small accent line or underline in ${secondaryColor} for design detail.

Lighting is cinematic and glossy, with sharp reflections and high contrast. Emphasize textures (liquid, glass, metal, packaging material) in extreme detail. Use a shallow depth of field for realism. Brand colors: primary ${primaryColor}, accent ${secondaryColor}.

Composition is balanced: bold ${primaryColor} text on the left side, ${parsed.brand_name} product on the right, with motion (splashes or energy effects) crossing into the frame for dynamism.

Style: premium brand ad, hyper-detailed, 4K, crisp, vibrant, commercial photography, dramatic splash effects, clean advertising layout, photorealistic.`;

    return parsed;
  } catch (e) {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Failed to parse brand research: " + clean.slice(0, 300));
  }
}

async function startNanaBanana(prompt) {
  const res = await fetch(
    "https://api.replicate.com/v1/models/google/nano-banana-pro/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          prompt,
          aspect_ratio: "4:5",
          output_format: "jpg",
          allow_fallback_model: true,
        },
      }),
    }
  );
  const text = await res.text();
  console.log("NanaBanana start:", res.status, text.slice(0, 300));
  if (!res.ok) throw new Error(`NanaBanana failed ${res.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  if (data.error) throw new Error(`NanaBanana error: ${data.error}`);
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
    console.log("Image prompt:", brand.ads[0].image_prompt.slice(0, 200));

    const pid = await startNanaBanana(brand.ads[0].image_prompt);
    console.log("NanaBanana prediction started:", pid);

    return res.status(200).json({ brand, predictionIds: [pid] });
  } catch (err) {
    console.error("Generate error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
