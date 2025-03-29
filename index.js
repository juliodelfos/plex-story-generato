const express = require('express')
const fetch = require('node-fetch')
const sharp = require('sharp')
const fs = require('fs')
const path = require('path')

const app = express()
const PORT = 3000
const PLEX_SERVER_URL = 'http://<IP_DEL_SERVIDOR_PLEX>:32400'
const PLEX_TOKEN = 'TU_PLEX_TOKEN'
const OUTPUT_DIR = path.join(__dirname, 'stories')

app.use(express.json())

app.post('/webhook', async (req, res) => {
  const payload = req.body

  if (payload.event === 'media.play' && payload.Metadata?.type === 'track') {
    const { title, grandparentTitle, thumb } = payload.Metadata
    const thumbUrl = `${PLEX_SERVER_URL}${thumb}?X-Plex-Token=${PLEX_TOKEN}`

    try {
      await generarImagenHistoria({ title, artist: grandparentTitle, thumbUrl })
      console.log(`Imagen generada para: ${grandparentTitle} - ${title}`)
    } catch (error) {
      console.error('Error generando imagen:', error)
    }
  }

  res.sendStatus(200)
})

async function generarImagenHistoria({ title, artist, thumbUrl }) {
  const portadaBuffer = await fetch(thumbUrl).then(res => res.buffer())

  // SVG con textos pequeños y centrados
  const svgText = `
    <svg width="1080" height="1920">
      <style>
        .title { fill: white; font-size: 50px; font-weight: bold; }
        .artist { fill: white; font-size: 36px; }
        .plex { fill: #ffffff55; font-size: 24px; font-family: sans-serif; }
        .highlight { fill: #ffcc00; }
      </style>
      <text x="540" y="1400" text-anchor="middle" class="title">${title}</text>
      <text x="540" y="1460" text-anchor="middle" class="artist">${artist}</text>
      <text x="540" y="1860" text-anchor="middle" class="plex">PL<tspan class="highlight">E</tspan>X</text>
    </svg>
  `
  const svgBuffer = Buffer.from(svgText)

  const outputFilePath = path.join(OUTPUT_DIR, `${Date.now()}.png`)

  await sharp({
    create: {
      width: 1080,
      height: 1920,
      channels: 3,
      background: '#000'
    }
  })
    .composite([
      {
        input: portadaBuffer,
        top: 200,
        left: 140, // más grande la carátula (800x800)
        raw: { width: 800, height: 800, channels: 3 }
      },
      { input: svgBuffer, top: 0, left: 0 }
    ])
    .png()
    .toFile(outputFilePath)
}

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR)

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`)
})
