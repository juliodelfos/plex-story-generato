import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { subirACloudflareR2, listarArchivosEnR2 } from "./r2.js";
import "dotenv/config";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const OUTPUT_DIR = path.join(__dirname, "stories");
const ASSETS_DIR = path.join(__dirname, "assets");

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
    const plexToken = process.env.PLEX_TOKEN;
    const plexUrl = process.env.PLEX_SERVER_URL;
    const thumbUrl = `${plexUrl}${thumb}?X-Plex-Token=${plexToken}`;

    console.log(`🎧 Reproduciendo: ${grandparentTitle} - ${title}`);
    console.log("🌍 URL de la carátula:", thumbUrl);

    const response = await fetch(thumbUrl);
    const buffer = await response.arrayBuffer();
    const imageLocalPath = path.join(__dirname, "cover.jpg");
    fs.writeFileSync(imageLocalPath, Buffer.from(buffer));

    const blurredPath = path.join(__dirname, "blurred.jpg");
    await sharp(imageLocalPath)
      .resize(1080, 1920, { fit: "cover" })
      .blur(30)
      .toFile(blurredPath);

    const stats = await sharp(blurredPath).stats();
    const brightness =
      (stats.channels[0].mean +
        stats.channels[1].mean +
        stats.channels[2].mean) /
      3;
    const theme = brightness > 127 ? "light" : "dark";

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

    const htmlContent = `
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            width: 1080px;
            height: 1920px;
            display: flex;
            justify-content: center;
            align-items: center;
            background: no-repeat center/cover url("file://${blurredPath}");
            position: relative;
            font-family: sans-serif;
            color: white;
          }
          .content {
            text-align: center;
            z-index: 1;
          }
          .cover {
            width: 700px;
            border-radius: 24px;
            box-shadow: 0 0 60px 10px rgba(255, 255, 255, 0.3);
          }
          .title {
            margin-top: 60px;
            font-size: 64px;
            font-weight: bold;
          }
          .artist {
            margin-top: 12px;
            font-size: 48px;
            color: #ddd;
          }
          .plex-logo {
            position: absolute;
            bottom: 80px;
            width: 200px;
            opacity: 0.85;
          }
          .dark-logo { display: none; }
          body.light .dark-logo { display: block; }
          body.light .light-logo { display: none; }
        </style>
      </head>
      <body class="${theme}">
        <div class="content">
          <img src="file://${imageLocalPath}" class="cover" />
          <div class="title">${safeTitle}</div>
          <div class="artist">${safeArtist}</div>
        </div>
        <img src="file://${path.join(
          ASSETS_DIR,
          "plex-logo-full-color-on-white.png"
        )}" class="plex-logo light-logo" />
        <img src="file://${path.join(
          ASSETS_DIR,
          "plex-logo-full-color-on-black.png"
        )}" class="plex-logo dark-logo" />
      </body>
      </html>
    `;

    const htmlPath = path.join(__dirname, "template.html");
    fs.writeFileSync(htmlPath, htmlContent);

    const browser = await puppeteer.launch({
      headless: chromium.headless,
      executablePath: await chromium.executablePath(),
      args: chromium.args,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920 });
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle0" });
    await page.screenshot({ path: outputFilePath });
    await browser.close();

    await subirACloudflareR2(outputFilePath, fileName);
    console.log(`✅ Imagen subida a R2: ${fileName}`);

    fs.unlinkSync(outputFilePath);
    fs.unlinkSync(htmlPath);
    fs.unlinkSync(imageLocalPath);
    fs.unlinkSync(blurredPath);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Error procesando webhook:", err);
    res.status(400).json({ ok: false, error: "Error al procesar el payload" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor local corriendo en http://localhost:${PORT}`);
});
