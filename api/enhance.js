export const config = { maxDuration: 60 };

function getIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.headers["x-real-ip"] ||
    "unknown"
  );
}

const ipLog = new Map();
function checkRateLimit(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${ip}:${today}`;
  const count = (ipLog.get(key) || 0) + 1;
  ipLog.set(key, count);
  if (ipLog.size > 5000) for (const [k] of ipLog) { if (!k.endsWith(today)) ipLog.delete(k); }
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return { count, hoursLeft: Math.ceil((midnight - now) / 1000 / 3600) };
}

async function uploadToBlob(imageBase64, mediaType) {
  const { put } = await import("@vercel/blob");
  const buffer = Buffer.from(imageBase64, "base64");
  const ext = mediaType.split("/")[1]?.split("+")[0] || "jpg";
  const blob = await put(`enhance-${Date.now()}.${ext}`, buffer, {
    access: "public",
    contentType: mediaType,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return blob.url;
}

async function uploadUrlToBlob(imageUrl, label) {
  const { put } = await import("@vercel/blob");
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch ${label} result`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const blob = await put(`pipeline-${label}-${Date.now()}.png`, buffer, {
    access: "public",
    contentType: "image/png",
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return blob.url;
}

// ── STAGE 1: Real-ESRGAN — fast pixel rebuilder, cleans up noise/artifacts ──
async function startStage1(imageUrl) {
  const res = await fetch(
    "https://api.replicate.com/v1/models/nightmareai/real-esrgan/predictions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { image: imageUrl, scale: 2, face_enhance: false },
      }),
    }
  );
  const text = await res.text();
  console.log("Stage1 ESRGAN:", res.status, text.slice(0, 300));
  if (!res.ok) throw new Error(`Stage1 failed ${res.status}: ${text}`);
  const data = JSON.parse(text);
  if (data.error) throw new Error(`Stage1 error: ${data.error}`);
  return data.id;
}

// ── STAGE 2: Clarity Upscaler — diffusion-based texture + detail hallucination ──
async function startStage2(imageUrl, mode) {
  const creativityMap = { auto: 0.5, photo: 0.35, art: 0.75 };
  const creativity = creativityMap[mode] || 0.5;
  const res = await fetch(
    "https://api.replicate.com/v1/models/philz1337x/clarity-upscaler/predictions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: {
          image: imageUrl,
          scale_factor: 2,
          creativity: creativity,
          resemblance: 1.0,
          sharpen: 4,
          dynamic: 6,
          handfix: "disabled",
          output_format: "png",
          prompt: "masterpiece, best quality, highres, ultra detailed, sharp focus, intricate textures, crisp edges, photorealistic",
          negative_prompt: "blurry, blur, lowres, bad quality, soft, smooth, out of focus, noise, grain",
          num_inference_steps: 20,
          sd_model: "juggernaut_reborn.safetensors [338b85bc4f]",
        },
      }),
    }
  );
  const text = await res.text();
  console.log("Stage2 Clarity:", res.status, text.slice(0, 300));
  if (!res.ok) throw new Error(`Stage2 failed ${res.status}: ${text}`);
  const data = JSON.parse(text);
  if (data.error) throw new Error(`Stage2 error: ${data.error}`);
  return data.id;
}

// ── STAGE 3: Topaz — final precision sharpening + artifact cleanup ──
async function startStage3(imageUrl) {
  const res = await fetch(
    "https://api.replicate.com/v1/models/topazlabs/image-upscale/predictions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { image: imageUrl, scale_factor: 1 },
      }),
    }
  );
  const text = await res.text();
  console.log("Stage3 Topaz:", res.status, text.slice(0, 300));
  if (!res.ok) throw new Error(`Stage3 failed ${res.status}: ${text}`);
  const data = JSON.parse(text);
  if (data.error) throw new Error(`Stage3 error: ${data.error}`);
  return data.id;
}

async function waitForPrediction(predictionId, label, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 4000));
    const res = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` },
    });
    const p = await res.json();
    console.log(`${label} status:`, p.status);
    if (p.status === "succeeded") {
      return Array.isArray(p.output) ? p.output[0] : p.output;
    }
    if (p.status === "failed" || p.status === "canceled") {
      throw new Error(`${label} failed: ${p.error}`);
    }
  }
  throw new Error(`${label} timed out`);
}

async function runClaudeAnalysis(imageBase64, mediaType, resolution, mode) {
  const resMap = { "2K": "2560x1440", "4K": "3840x2160", "8K": "7680x4320" };
  const targetRes = resMap[resolution] || "3840x2160";
  const prompt = `Analyze this image and return JSON only, no markdown.
{
  "quality_score": number 1-10,
  "noise_level": "low"|"medium"|"high",
  "sharpness": "soft"|"average"|"sharp",
  "subject_type": "string",
  "color_profile": "string",
  "enhancements_applied": ["item1","item2","item3","item4"],
  "upscale_recommendation": "one sentence",
  "target_resolution": "${targetRes}"
}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 800,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
        { type: "text", text: prompt },
      ]}],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const raw = data.content.map(i => i.text || "").join("");
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

async function fetchImageAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch result: ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { action, imageBase64, mediaType, resolution, mode, pipelineId } = req.body;

  // ── POLL pipeline state ──
  if (action === "poll") {
    if (!pipelineId) return res.status(400).json({ error: "Missing pipelineId" });
    try {
      const r = await fetch(`https://api.replicate.com/v1/predictions/${pipelineId}`, {
        headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` },
      });
      const p = await r.json();
      console.log("Poll:", pipelineId, "->", p.status);
      if (p.status === "succeeded") {
        const url = Array.isArray(p.output) ? p.output[0] : p.output;
        return res.status(200).json({ status: "succeeded", enhancedImageBase64: await fetchImageAsBase64(url), enhancedMediaType: "image/png" });
      }
      if (p.status === "failed" || p.status === "canceled") {
        return res.status(200).json({ status: "failed", error: p.error || "Stage failed" });
      }
      return res.status(200).json({ status: p.status });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POLL pipeline stage (multi-stage needs special handling) ──
  if (action === "poll_pipeline") {
    const { stage, predictionId: pid } = req.body;
    try {
      const r = await fetch(`https://api.replicate.com/v1/predictions/${pid}`, {
        headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` },
      });
      const p = await r.json();
      console.log(`Stage${stage} poll:`, pid, "->", p.status);
      if (p.status === "succeeded") {
        const url = Array.isArray(p.output) ? p.output[0] : p.output;
        return res.status(200).json({ status: "succeeded", outputUrl: url, stage });
      }
      if (p.status === "failed" || p.status === "canceled") {
        return res.status(200).json({ status: "failed", error: p.error, stage });
      }
      return res.status(200).json({ status: p.status, stage });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── ADVANCE pipeline: hand off to next stage ──
  if (action === "advance_stage") {
    const { stage, imageUrl: inUrl, mode: inMode } = req.body;
    try {
      let pid;
      if (stage === 2) {
        pid = await startStage2(inUrl, inMode || "auto");
      } else if (stage === 3) {
        pid = await startStage3(inUrl);
      }
      return res.status(200).json({ status: "started", predictionId: pid, stage });
    } catch (err) {
      console.error("Advance stage error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── START pipeline ──
  const ip = getIP(req);
  const { count, hoursLeft } = checkRateLimit(ip);
  if (count > 100) return res.status(429).json({ error: "daily_limit_reached", message: `You've used your 1 free enhancement today. Resets in ~${hoursLeft}h.`, resetsIn: hoursLeft });
  if (!imageBase64 || !mediaType) return res.status(400).json({ error: "Missing imageBase64 or mediaType" });

  try {
    console.log("Uploading to Vercel Blob...");
    const imageUrl = await uploadToBlob(imageBase64, mediaType);
    console.log("Blob URL:", imageUrl);

    // Start stage 1 + Claude analysis in parallel
    const [pid, analysis] = await Promise.all([
      startStage1(imageUrl),
      runClaudeAnalysis(imageBase64, mediaType, resolution, mode).catch(e => { console.error("Claude:", e.message); return null; }),
    ]);

    return res.status(200).json({ status: "started", predictionId: pid, stage: 1, result: analysis });
  } catch (err) {
    console.error("Start error:", err.message);
    return res.status(500).json({ error: "Enhancement failed", message: err.message });
  }
}
