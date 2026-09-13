import multer from "multer";

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export function businessIdOf(req: { session: { businessId?: string } }): string {
  return req.session.businessId as string;
}

// WhatsApp's Cloud API rejects image/gif outright ("Unsupported Image mime type image/gif") - and it
// does so asynchronously, after already accepting the send request, so the caller has no synchronous
// error to react to. Block it at upload time instead of letting it silently fail delivery later.
export function isUnsupportedImageType(mimetype: string): boolean {
  return mimetype === "image/gif";
}
