import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { env } from "../config/env";

let s3: S3Client | null = null;

function getS3Client(): S3Client {
  if (!env.aws.region || !env.aws.bucket) {
    throw new Error("AWS S3 no esta configurado todavia (faltan AWS_REGION / AWS_S3_BUCKET en .env)");
  }
  if (!s3) {
    s3 = new S3Client({
      region: env.aws.region,
      credentials: {
        accessKeyId: env.aws.accessKeyId,
        secretAccessKey: env.aws.secretAccessKey,
      },
    });
  }
  return s3;
}

export async function uploadMedia(
  buffer: Buffer,
  contentType: string,
  folder: "images" | "videos"
): Promise<{ key: string; url: string }> {
  const extension = contentType.split("/")[1] ?? "bin";
  const key = `${folder}/${randomUUID()}.${extension}`;

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: env.aws.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  const url = await getPresignedMediaUrl(key);
  return { key, url };
}

export async function getPresignedMediaUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({ Bucket: env.aws.bucket, Key: key });
  return getSignedUrl(getS3Client(), command, { expiresIn: 60 * 60 * 24 * 6 });
}

export async function deleteMedia(key: string): Promise<void> {
  await getS3Client().send(new DeleteObjectCommand({ Bucket: env.aws.bucket, Key: key }));
}
