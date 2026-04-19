export const config = { maxDuration: 60 };

async function researchBrand(url) {
  // Claude uses web search to research the brand then generates 3 ad prompts
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: "user",
        content: `Research this brand/website: ${url}

Search for: their products or services, brand aesthetic, target audience, brand colors, taglines, and what makes them unique.

Then generate exactly 1 high-converting Instagram/social media ad image prompt for Nano Banana Pro (an AI image generator).

The ad should follow this proven template (like the Alpecin Grey Attack ad style):
- Bold lifestyle photo with a person using/benefiting from the product
- Product prominently displayed
- Strong emotional hook
- Clean composition
- Professional photography quality, dramatic lighting
- IMPORTANT: Include large, bold, attention-grabbing typography overlaid on the image — the headline text should be massive, high-contrast, and dominate the composition like a billboard. Use the brand colors for the text. The words should feel like they are punching out of the image.

Return ONLY valid JSON, no markdown:
{
  "brand_name": "string",
  "brand_summary": "2-3 sentence brand description",
  "brand_colors": ["color1", "color2"],
  "target_audience": "string",
  "ads": [
    {
      "concept": "Short concept name (e.g. 'The Confidence Shot')",
      "headline": "Bold ad headline (5 words max)",
      "subheadline": "Supporting line (8 words max)",
      "cta": "CTA button text (3 words max)",
      "image_prompt": "Detailed Nano Banana Pro image generation prompt. Be extremely specific about the person, their emotion, the product placement, lighting, background, composition, camera angle, and mood. Include massive bold headline text overlaid on the image in brand colors, punching out of the composition like a billboard. Make it feel like a premium magazine ad. End with: photorealistic, 4K, professional advertising photography, studio lighting, sharp focus, high dynamic range, bold typography, impactful text overlay."
    }
  ]
}`
      }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  // Extract text from response (may include tool use blocks)
  const textBlocks = data.content.filter(b => b.type === "text");
  const raw = textBlocks.map(b => b.text).join("");
  const clean = raw.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(clean);
  } catch (e) {
    // Try to extract JSON from the response
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Failed to parse brand research: " + clean.slice(0, 200));
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
    console.log("Brand research done:", brand.brand_name);

    // Single prediction — one image
    const pid = await startNanaBanana(brand.ads[0].image_prompt);
    const predictionIds = [pid];

    console.log("Started predictions:", predictionIds);

    return res.status(200).json({
      brand,
      predictionIds,
    });
  } catch (err) {
    console.error("Generate error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
