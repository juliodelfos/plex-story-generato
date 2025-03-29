// ... (código inicial igual que antes, sin cambios)

app.post('/webhook', async (req, res) => {
  let payload
  const raw = req.body

  console.log('🔍 Raw body recibido:\n', raw.slice(0, 500))

  const multipartMatch = raw.match(/name="payload"\r?\nContent-Type: application\/json\r?\n\r?\n([\s\S]*?)\r?\n--/)

  if (multipartMatch) {
    try {
      payload = JSON.parse(multipartMatch[1])
    } catch (e) {
      console.error('❌ Fallo al parsear JSON desde multipart:', e.message)
      return res.status(400).json({ ok: false, error: 'Payload inválido en multipart' })
    }
  } else {
    try {
      payload = JSON.parse(raw)
    } catch (e) {
      console.error('❌ Fallo al parsear JSON directo:', e.message)
      return res.status(400).json({ ok: false, error: 'JSON inválido' })
    }
  }

  console.log('📨 Webhook recibido:\n', JSON.stringify(payload, null, 2))

  if (payload.event !== 'media.play' || payload.Metadata?.type !== 'track') {
    return res.status(200).json({ ok: false, reason: 'No es una canción reproducida' })
  }

  const { title, grandparentTitle, thumb } = payload.Metadata
  console.log(`🎧 Reproduciendo: ${grandparentTitle} - ${title}`)

  const plexToken = process.env.PLEX_TOKEN
  const plexUrl =
    process.env.NODE_ENV === 'production'
      ? 'https://192-168-0-27.c17dbc18c9b248b5b7ba8eb2e5961f57.plex.direct:32400'
      : process.env.PLEX_SERVER_URL

  const thumbUrl = `${plexUrl}${thumb}?X-Plex-Token=${plexToken}`
  console.log('🌍 URL de la carátula:', thumbUrl) // 👈 este es el log nuevo

  const safeTitle = `${grandparentTitle}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const fileName = `${Date.now()}-${safeTitle}.png`
  const outputFilePath = path.join(OUTPUT_DIR, fileName)

  try {
    const portadaResponse = await fetch(thumbUrl)
    const contentType = portadaResponse.headers.get('content-type')

    if (!contentType?.startsWith('image/')) {
      console.warn(`⚠️ Thumb no es imagen válida (${contentType})`)
      return res.status(200).json({ ok: false, reason: 'Thumb no es imagen válida' })
    }

    const portadaBuffer = await portadaResponse.buffer()

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
    console.log(`✅ Imagen subida a R2: ${fileName}`)

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
