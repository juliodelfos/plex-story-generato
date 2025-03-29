import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
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
  const fileContent = fs.readFileSync(filePath)

  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: fileName,
    Body: fileContent,
    ContentType: 'image/png'
  })

  await r2.send(command)
}
