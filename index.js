import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { subirACloudflareR2, listarArchivosEnR2 } from "./r2.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const OUTPUT_DIR = path.join(__dirname, "stories");

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

app.use(express.text({ type: "*/*" }));

app.get("/status", (req, res) => {
  res.send("Servidor funcionando ✅");
});

app.get("/imagenes", async (req, res) => {
  try {
    const archivos = await listarArchivosEnR2();

    const html = `
      <html>
        <head>
          <title>Imágenes generadas</title>
          <style>
            body { font-family: sans-serif; padding: 2rem; background: #111; color: #fff; }
            img { max-width: 320px; border-radius: 12px; margin-bottom: 0.5rem; }
            .item { margin-bottom: 2rem; }
            a { color: #00ccff; font-size: 0.9rem; word-break: break-word; }
          </style>
        </head>
        <body>
          <h1>🖼️ Imágenes generadas</h1>
          ${archivos
            .map(
              (nombre) => `
            <div class="item">
              <img src="https://${process.env.WORKER_DOMAIN}/${nombre}" alt="${nombre}" />
              <div><a href="https://${process.env.WORKER_DOMAIN}/${nombre}" target="_blank">${nombre}</a></div>
            </div>
          `
            )
            .join("")}
        </body>
      </html>
    `;
    res.send(html);
  } catch (err) {
    console.error("❌ Error listando archivos desde R2:", err);
    res.status(500).send("Error al listar archivos: " + err.message);
  }
});

app.post("/webhook", async (req, res) => {
  let payload;
  const raw = req.body;

  console.log("🔍 Raw body recibido:\n", raw.slice(0, 500));

  try {
    const multipartMatch = raw.match(
      /name="payload"\r?\nContent-Type: application\/json\r?\n\r?\n([\s\S]*?)\r?\n--/
    );
    if (multipartMatch) {
      payload = JSON.parse(multipartMatch[1]);
    } else {
      payload = JSON.parse(raw);
    }

    console.log("📨 Webhook recibido:\n", JSON.stringify(payload, null, 2));

    if (payload.event !== "media.play" || payload.Metadata?.type !== "track") {
      return res
        .status(200)
        .json({ ok: false, reason: "No es una canción reproducida" });
    }

    const { title, grandparentTitle, thumb } = payload.Metadata;
    console.log(`🎧 Reproduciendo: ${grandparentTitle} - ${title}`);

    const plexToken = process.env.PLEX_TOKEN;
    const plexUrl = process.env.PLEX_SERVER_URL;
    const thumbUrl = `${plexUrl}${thumb}?X-Plex-Token=${plexToken}`;

    console.log("🌍 URL de la carátula:", thumbUrl);

    const sanitize = (text, max = 40) =>
      text?.length > max ? text.slice(0, max) + "…" : text || "Desconocido";

    const safeTitle = sanitize(title);
    const safeArtist = sanitize(grandparentTitle);
    const fileName = `${Date.now()}-${safeArtist
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}-${safeTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}.png`;
    const outputFilePath = path.join(OUTPUT_DIR, fileName);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);
      const portadaResponse = await fetch(thumbUrl, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      console.log(
        "📥 Respuesta portada:",
        portadaResponse.status,
        portadaResponse.headers.get("content-type")
      );

      const contentType = portadaResponse.headers.get("content-type");
      if (!contentType?.startsWith("image/")) {
        console.warn(`⚠️ Thumb no es imagen válida (${contentType})`);
        return res
          .status(200)
          .json({ ok: false, reason: "Thumb no es imagen válida" });
      }

      const portadaBuffer = await portadaResponse.arrayBuffer();
      const resizedCoverBuffer = await sharp(Buffer.from(portadaBuffer))
        .resize(900, 900, { fit: "cover" })
        .toBuffer();

      const fontData = fs
        .readFileSync(path.join(__dirname, "assets/Inter_18pt-Regular.ttf"))
        .toString("base64");
      const fontFace = `@font-face { font-family: 'Inter'; src: url(data:font/ttf;base64,${fontData}) format('truetype'); }`;

      const svg = `
        <svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
          <style>
            ${fontFace}
            .title { font-family: 'Inter'; fill: white; font-size: 64px; font-weight: bold; }
            .artist { font-family: 'Inter'; fill: white; font-size: 42px; }
            .plex { font-family: 'Inter'; fill: #ffffff55; font-size: 28px; }
            .highlight { fill: #ffcc00; }
          </style>
          <text x="540" y="1450" text-anchor="middle" class="title">${safeTitle}</text>
          <text x="540" y="1520" text-anchor="middle" class="artist">${safeArtist}</text>
          <text x="540" y="1860" text-anchor="middle" class="plex">PL<tspan class="highlight">E</tspan>X</text>
        </svg>
      `;
      const svgBuffer = Buffer.from(svg);

      await sharp({
        create: {
          width: 1080,
          height: 1920,
          channels: 3,
          background: "#000",
        },
      })
        .composite([
          { input: resizedCoverBuffer, top: 180, left: 90 },
          { input: svgBuffer, top: 0, left: 0 },
        ])
        .png()
        .toFile(outputFilePath);

      await subirACloudflareR2(outputFilePath, fileName);
      console.log(`✅ Imagen subida a R2: ${fileName}`);

      fs.unlinkSync(outputFilePath);
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error("❌ Error generando imagen:", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  } catch (err) {
    console.error("❌ Error procesando webhook:", err);
    res.status(400).json({ ok: false, error: "Error al procesar el payload" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor local corriendo en http://localhost:${PORT}`);
});
