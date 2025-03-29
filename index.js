import express from 'express'
import fetch from 'node-fetch'
import sharp from 'sharp'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import 'dotenv/config'
import { subirACloudflareR2 } from './r2.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3000
const OUTPUT_DIR = path.join(__dirname, 'stories')

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR)

app.use(express.json())

app.get('/status', (req, res) => {
  res.send('Servidor funcionando ✅')
})

app.post('/webhook', async (req, res) => {
  const payload = req.body

  if (payload.event !== 'media.play' || payload.Metadata?.type !== 'track') {
    return res.status(200).json({ ok: false, reason: 'No es una canción reproducida' })
  }

  const { title, grandparentTitle, thumb } = payload.Metadata
  console.log(`🎧 Reproduciendo: ${grandparentTitle} - ${title}`)

  const plexUrl = process.env.PLEX_SERVER_URL
  const plexToken = process.env.PLEX_TOKEN
  const thumbUrl = `${plexUrl}${thumb}?X-Plex-Token=${plexToken}`

  // Nombre de archivo legible
  const safeTitle = `${grandparentTitle}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const fileName = `${Date.now()}-${safeTitle}.png`
  const outputFilePath = path.join(OUTPUT_DIR, fileName)

  try {
    const portadaBuffer = await fetch(thumbUrl).then(res => res.buffer())

    const svg = `
      <svg width="1080" height="1920">
        <style>
          .title { fill: white; font-size: 50px; font-weight: bold; }
          .artist { fill: white; font-size: 36px; }
          .plex { fill: #ffffff55; font-size: 24px; font-family: sans-serif; }
          .highlight { fill: #ffcc00; }
        </style>
        <text x="540" y="1400" text-anchor="middle" class="title">${title}</text>
        <text x="540" y="1460" text-anchor="middle" class="artist">${grandparentTitle}</text>
        <text x="540" y="1860" text-anchor="middle" class="plex">PL<tspan class="highlight">E</tspan>X</text>
      </svg>
    `
    const svgBuffer = Buffer.from(svg)

    await sharp({
      create: {
        width: 1080,
        height: 1920,
        channels: 3,
        background: '#000'
      }
    })
      .composite([
        { input: portadaBuffer, top: 200, left: 140 },
        { input: svgBuffer, top: 0, left: 0 }
      ])
      .png()
      .toFile(outputFilePath)

    await subirACloudflareR2(outputFilePath, fileName)
    console.log(`✅ Imagen generada y subida a R2: ${fileName}`)

    fs.unlinkSync(outputFilePath)
    res.status(200).json({ ok: true })
  } catch (err) {
    console.error('❌ Error generando imagen:', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`🚀 Servidor local corriendo en http://localhost:${PORT}`)
})
