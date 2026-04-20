export const config = { maxDuration: 60 };

async function fetchPageContent(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AdGen/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    const html = await res.text();
    // Strip tags, collapse whitespace, keep first 8000 chars
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 8000);
    return text;
  } catch (e) {
    console.log("Page fetch failed:", e.message);
    return "";
  }
}

async function researchBrand(url, pageContent) {
  const hostname = new URL(url).hostname.replace("www.", "");

  const contextSection = pageContent
    ? `Here is the actual text content scraped from ${url}:\n\n"""\n${pageContent}\n"""\n\nUse this as your PRIMARY source.`
    : `Could not fetch the page directly. Use web search to find information about ${url}.`;

  // No tools — we already have the page content, just tell Claude to return JSON
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
      messages: [
        {
          role: "user",
          content: `Analyze this brand from the page content below and return ONLY a JSON object. No intro text, no explanation, no markdown — start your response with { and end with }.

Page URL: ${url}

${contextSection}

Return this exact JSON structure:
{
  "brand_name": "exact brand name from the page",
  "brand_summary": "2-3 sentences describing what the brand actually does",
  "brand_colors": ["#hexcode1", "#hexcode2"],
  "target_audience": "specific demographic",
  "ads": [
    {
      "concept": "short concept name",
      "headline": "2-4 words ALL CAPS",
      "subheadline": "supporting line 8 words max",
      "cta": "CTA 3 words max"
    }
  ]
}

For brand_colors: look for color mentions in the text, or infer from brand personality. Use real hex codes.
Start your response with { now:`
        },
        {
          role: "assistant",
          content: "{"
        }
      ],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const textBlocks = data.content.filter(b => b.type === "text");
  const raw = "{" + textBlocks.map(b => b.text).join("");
  console.log("Claude raw response:", raw.slice(0, 300));
  const clean = raw.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error("Failed to parse brand research: " + clean.slice(0, 200));
  }

  // Inject the cinematic prompt template
  const ad = parsed.ads[0];
  const colors = parsed.brand_colors || [];
  const primaryColor = colors[0] || "#ffffff";
  const secondaryColor = colors[1] || "#000000";

  ad.image_prompt = `Ultra-realistic, cinematic commercial shot of a ${parsed.brand_name} product — ${ad.concept}. Minimal, controlled composition with the product as the clear focal point, centered or slightly off-center. Background is clean and moody: soft gradient in ${secondaryColor}, subtle texture, or a dimly lit environment. Refined color palette of 2–3 tones using ${primaryColor} and ${secondaryColor}, slightly desaturated and cohesive. No chaotic or overly saturated elements.

Lighting is directional and dramatic — soft highlights, deep shadows, gentle rim light. Motion is subtle and intentional: slow liquid movement, light mist, condensation, or gentle particles.

Typography: the words "${ad.headline}" in modern sans-serif, bold but restrained, positioned cleanly with generous spacing. Color: ${primaryColor}. Confident, understated tone.

Composition: product on a reflective surface with subtle condensation, or hand holding the product in low light with soft rim lighting, or close-up macro shot emphasizing material texture.

Style references: luxury brand campaigns, high-end fragrance ads, cinematic product photography, Apple-style minimalism, Nike quiet confidence. 4K, ultra-detailed, shallow depth of field, realistic materials, premium commercial look, photorealistic.`;

  return parsed;
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
    console.log("Fetching page:", url);
    const pageContent = await fetchPageContent(url);
    console.log("Page content length:", pageContent.length);

    const brand = await researchBrand(url, pageContent);
    console.log("Brand:", brand.brand_name, "Colors:", brand.brand_colors);

    const pid = await startNanaBanana(brand.ads[0].image_prompt);
    console.log("NanaBanana prediction started:", pid);

    return res.status(200).json({ brand, predictionIds: [pid] });
  } catch (err) {
    console.error("Generate error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
