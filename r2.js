// r2.js
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const fs = require('fs')
const path = require('path')

// Configuración con tus credenciales de R2
const r2 = new S3Client({
  region: 'auto',
  endpoint: 'https://<TU-ID>.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: '<TU_ACCESS_KEY>',
    secretAccessKey: '<TU_SECRET_KEY>'
  }
})

async function subirACloudflareR2(filePath, fileName) {
  const fileContent = fs.readFileSync(filePath)

  const command = new PutObjectCommand({
    Bucket: 'plex-stories',
    Key: fileName,
    Body: fileContent,
    ContentType: 'image/png'
  })

  await r2.send(command)
  console.log(`Imagen subida a R2: ${fileName}`)
}

module.exports = { subirACloudflareR2 }
