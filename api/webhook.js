import { subirACloudflareR2 } from '../r2.js'
import sharp from 'sharp'
import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('Método no permitido')

  const payload = req.body

  if (payload.event === 'media.play' && payload.Metadata?.type === 'track') {
    const { title, grandparentTitle, thumb } = payload.Metadata
    const plexToken = process.env.PLEX_TOKEN
    const plexUrl = process.env.PLEX_SERVER_URL
    const thumbUrl = `${plexUrl}${thumb}?X-Plex-Token=${plexToken}`
    const fileName = `${Date.now()}.png`
    const tempFilePath = `/tmp/${fileName}`

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
        .toFile(tempFilePath)

      await subirACloudflareR2(tempFilePath, fileName)
      fs.unlinkSync(tempFilePath) // limpieza
    } catch (error) {
      console.error('Error generando imagen:', error)
    }
  }

  return res.status(200).json({ ok: true })
}
