import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { subirACloudflareR2, listarArchivosEnR2 } from "./r2.js";
import "dotenv/config";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import sharp from "sharp";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const OUTPUT_DIR = path.join(__dirname, "stories");
const ASSETS_DIR = path.join(__dirname, "assets");
const CACHE_DIR = path.join(__dirname, "cache");

// Crear directorios necesarios si no existen
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

// Verificar variables de entorno requeridas
const requiredEnvVars = ["PLEX_TOKEN", "PLEX_SERVER_URL", "WORKER_DOMAIN"];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(`❌ Variable de entorno ${varName} no configurada`);
    process.exit(1);
  }
});

app.use(express.text({ type: "*/*", limit: "2mb" }));

// Función para generar un hash único para cada URL
const getUrlHash = (url) => {
  return crypto.createHash("md5").update(url).digest("hex");
};

// Función para obtener la carátula del álbum con caché
const getAlbumCoverWithCache = async (thumbUrl) => {
  const urlHash = getUrlHash(thumbUrl);
  const cachedFilePath = path.join(CACHE_DIR, `${urlHash}.jpg`);

  // Verificar si existe en caché
  if (fs.existsSync(cachedFilePath)) {
    console.log(`🔄 Usando carátula en caché: ${urlHash}`);
    // Crear una copia para el procesamiento actual
    const imageLocalPath = path.join(__dirname, "cover.jpg");
    fs.copyFileSync(cachedFilePath, imageLocalPath);
    return imageLocalPath;
  }

  // Si no existe, descargar y guardar en caché
  console.log(`📥 Descargando carátula: ${thumbUrl}`);
  const response = await fetch(thumbUrl);

  if (!response.ok) {
    throw new Error(`Error al descargar carátula: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  fs.writeFileSync(cachedFilePath, Buffer.from(buffer));

  // También guardar una copia para el procesamiento actual
  const imageLocalPath = path.join(__dirname, "cover.jpg");
  fs.writeFileSync(imageLocalPath, Buffer.from(buffer));

  return imageLocalPath;
};

// Optimización de la imagen de portada
const optimizeAlbumCover = async (inputPath) => {
  const optimizedBuffer = await sharp(inputPath)
    .resize(700, 700, {
      fit: "cover",
      position: "centre",
    })
    .jpeg({
      quality: 85,
      progressive: true,
      force: false, // mantiene el formato original si no es JPEG
    })
    .webp({
      quality: 85,
      effort: 6, // mayor esfuerzo de compresión
      force: false, // mantiene el formato original si no es WebP
    })
    .toBuffer();

  // Sobrescribir el archivo original con la versión optimizada
  fs.writeFileSync(inputPath, optimizedBuffer);
  return inputPath;
};

// Optimización del fondo difuminado
const createOptimizedBlurredBackground = async (
  inputPath,
  outputPath,
  theme
) => {
  await sharp(inputPath)
    .resize(1080, 1920, {
      fit: "cover",
      position: "centre",
    })
    .blur(30)
    .modulate({
      brightness: theme === "dark" ? 0.8 : 1.2, // Ajustar brillo según el tema
      saturation: 1.2, // Aumentar saturación para más impacto visual
    })
    .webp({
      quality: 75, // Menor calidad para fondos es aceptable
      effort: 6,
    })
    .toFile(outputPath);

  return outputPath;
};

// Implementación de una limpieza periódica de caché
const cleanupCache = () => {
  const files = fs.readdirSync(CACHE_DIR);

  if (files.length > 100) {
    // Mantener máximo 100 archivos en caché
    console.log(`🧹 Limpiando caché (${files.length} archivos)`);

    // Ordenar por fecha de modificación, más antiguos primero
    const fileStats = files
      .map((file) => ({
        file,
        mtime: fs.statSync(path.join(CACHE_DIR, file)).mtime.getTime(),
      }))
      .sort((a, b) => a.mtime - b.mtime);

    // Eliminar los más antiguos dejando solo 50
    const filesToDelete = fileStats.slice(0, files.length - 50);
    filesToDelete.forEach(({ file }) => {
      fs.unlinkSync(path.join(CACHE_DIR, file));
    });

    console.log(
      `✅ Eliminados ${filesToDelete.length} archivos antiguos de caché`
    );
  }
};

// Ejecutar limpieza cada 24 horas
setInterval(cleanupCache, 24 * 60 * 60 * 1000);

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
  const tempFiles = []; // Rastrea todos los archivos temporales creados

  console.log("🔍 Raw body recibido:\n", raw.slice(0, 500));

  try {
    // Parseo del payload
    const multipartMatch = raw.match(
      /name="payload"\r?\nContent-Type: application\/json\r?\n\r?\n([\s\S]*?)\r?\n--/
    );

    if (multipartMatch) {
      payload = JSON.parse(multipartMatch[1]);
    } else {
      payload = JSON.parse(raw);
    }

    console.log("📨 Webhook recibido:\n", JSON.stringify(payload, null, 2));

    // Validación del evento
    if (payload.event !== "media.play" || payload.Metadata?.type !== "track") {
      return res
        .status(200)
        .json({ ok: false, reason: "No es una canción reproducida" });
    }

    // Obtención de datos y descarga de imagen
    const { title, grandparentTitle, thumb } = payload.Metadata;
    const plexToken = process.env.PLEX_TOKEN;
    const plexUrl = process.env.PLEX_SERVER_URL;
    const thumbUrl = `${plexUrl}${thumb}?X-Plex-Token=${plexToken}`;

    console.log(`🎧 Reproduciendo: ${grandparentTitle} - ${title}`);
    console.log("🌍 URL de la carátula:", thumbUrl);

    // Usar la función de caché para obtener la imagen
    const imageLocalPath = await getAlbumCoverWithCache(thumbUrl);
    tempFiles.push(imageLocalPath);

    // Optimizar la imagen de portada
    await optimizeAlbumCover(imageLocalPath);

    // Crear fondo difuminado
    const blurredPath = path.join(__dirname, "blurred.jpg");
    tempFiles.push(blurredPath);

    // Determinar tema basado en brillo de la imagen
    const stats = await sharp(imageLocalPath).stats();
    const brightness =
      (stats.channels[0].mean +
        stats.channels[1].mean +
        stats.channels[2].mean) /
      3;
    const theme = brightness > 127 ? "light" : "dark";

    // Crear fondo optimizado
    await createOptimizedBlurredBackground(imageLocalPath, blurredPath, theme);

    const sanitize = (text, max = 40) =>
      text?.length > max ? text.slice(0, max) + "…" : text || "Desconocido";

    const safeTitle = sanitize(title);
    const safeArtist = sanitize(grandparentTitle);
    const fileName = `${Date.now()}-${safeArtist
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}-${safeTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}.webp`;
    const outputFilePath = path.join(OUTPUT_DIR, fileName);
    tempFiles.push(outputFilePath);

    // Plantilla HTML mejorada
    const htmlContent = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8" />
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
    
        html, body {
          width: 1080px;
          height: 1920px;
          font-family: sans-serif;
          overflow: hidden;
          position: relative;
        }
    
        .background {
          position: absolute;
          inset: 0;
          background: url("file://${blurredPath}") center center / cover no-repeat;
          z-index: 0;
        }
    
        .overlay {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, ${theme === "dark" ? "0.3" : "0.1"});
          backdrop-filter: blur(10px);
          z-index: 1;
        }
    
        .content {
          position: relative;
          z-index: 2;
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          text-align: center;
          padding: 40px;
        }
    
        .cover {
          width: 700px;
          border-radius: 32px;
          box-shadow: 0 0 60px 10px rgba(255, 255, 255, 0.3);
          margin-bottom: 64px;
        }
    
        .title {
          font-size: 64px;
          font-weight: bold;
          color: ${theme === "dark" ? "#fff" : "#111"};
          text-shadow: 0 4px 8px rgba(0,0,0,${
            theme === "dark" ? "0.6" : "0.2"
          });
        }
    
        .artist {
          font-size: 48px;
          margin-top: 12px;
          color: ${theme === "dark" ? "#ddd" : "#444"};
          text-shadow: 0 2px 4px rgba(0,0,0,${
            theme === "dark" ? "0.6" : "0.2"
          });
        }
    
        .plex-logo {
          position: absolute;
          bottom: 80px;
          width: 200px;
          opacity: 0.95;
          z-index: 3;
        }
    
        .dark-logo { display: ${theme === "dark" ? "block" : "none"}; }
        .light-logo { display: ${theme === "dark" ? "none" : "block"}; }
      </style>
    </head>
    <body>
      <div class="background"></div>
      <div class="overlay"></div>
      <div class="content">
        <img src="file://${imageLocalPath}" class="cover" alt="${safeArtist} - ${safeTitle}" />
        <div class="title">${safeTitle}</div>
        <div class="artist">${safeArtist}</div>
      </div>
      <img src="file://${path.join(
        ASSETS_DIR,
        "plex-logo-full-color-on-white.webp"
      )}" class="plex-logo light-logo" alt="Plex Logo" />
      <img src="file://${path.join(
        ASSETS_DIR,
        "plex-logo-full-color-on-black.webp"
      )}" class="plex-logo dark-logo" alt="Plex Logo" />
    </body>
    </html>
    `;

    const htmlPath = path.join(__dirname, "template.html");
    tempFiles.push(htmlPath);
    fs.writeFileSync(htmlPath, htmlContent);

    // Renderizado con Puppeteer
    const browser = await puppeteer.launch({
      headless: chromium.headless,
      executablePath: await chromium.executablePath(),
      args: chromium.args,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920 });
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle0" });
    await page.screenshot({ path: outputFilePath, type: "webp" });
    await browser.close();

    // Subir a Cloudflare R2
    await subirACloudflareR2(outputFilePath, fileName);
    console.log(`✅ Imagen subida a R2: ${fileName}`);

    // Resultado exitoso
    res.status(200).json({
      ok: true,
      imageUrl: `https://${process.env.WORKER_DOMAIN}/${fileName}`,
    });
  } catch (err) {
    console.error("❌ Error procesando webhook:", err);
    res.status(400).json({ ok: false, error: err.message });
  } finally {
    // Limpieza garantizada de todos los archivos temporales
    console.log("🧹 Limpiando archivos temporales...");
    tempFiles.forEach((file) => {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
          console.log(`  ✓ Eliminado: ${path.basename(file)}`);
        }
      } catch (cleanupErr) {
        console.error(
          `  ✗ Error al eliminar ${path.basename(file)}:`,
          cleanupErr.message
        );
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor local corriendo en http://localhost:${PORT}`);
});
