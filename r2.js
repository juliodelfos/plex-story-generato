import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import fs from 'fs'
import 'dotenv/config'

const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
})

export async function subirACloudflareR2(filePath, fileName) {
  try {
    const fileContent = fs.readFileSync(filePath)

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: fileContent,
      ContentType: 'image/png'
    })

    await r2.send(command)
    console.log(`✅ Imagen subida a R2: ${fileName}`)
  } catch (err) {
    console.error('❌ Error al subir a R2:', err.message)
  }
}

export async function listarArchivosEnR2() {
  const command = new ListObjectsV2Command({
    Bucket: process.env.R2_BUCKET_NAME
  })

  const data = await r2.send(command)
  return (data.Contents || []).map(obj => obj.Key)
}
