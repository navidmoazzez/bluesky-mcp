/**
 * Getting images and video onto Bluesky.
 *
 * Images are a blob upload with a hard 1,000,000-byte ceiling that the server
 * enforces with an unhelpful error, so the size is checked here and reported in
 * megabytes with the actual limit named.
 *
 * Video is the interesting one. It is **not** `com.atproto.repo.uploadBlob`.
 * A video posted that way is stored but never transcoded, so the post publishes
 * with an embed that will not play. The real path is a separate service:
 * mint a service-auth token scoped to `app.bsky.video.uploadVideo` with the
 * video service as its audience, POST the bytes to video.bsky.app, then poll a
 * job until the transcode finishes and hands back the blob to embed. Neither
 * reference server implements video at all, and a naive `uploadBlob` version
 * looks like it works right up until nobody can play the post.
 */

import { setTimeout as delay } from "node:timers/promises";
import type { BlueskyClient } from "../api/client.js";
import type { Account, Config } from "../config.js";
import { AtpError, ValidationError } from "../api/errors.js";

/** The `{$type: blob, ref, mimeType, size}` record a post embed points at. */
export type BlobRef = Record<string, unknown>;

export type Fetched = { bytes: Uint8Array; contentType: string; source: string };

/** Bluesky rejects image blobs over this. The message it returns does not say so. */
export const MAX_IMAGE_BYTES = 1_000_000;

/** The service caps video at 10 minutes; size is checked against getUploadLimits. */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/**
 * Read media from a public URL or a data: URI.
 *
 * A `data:` URI is accepted because a model that just generated an image has
 * bytes, not a URL, and making it find somewhere to host them first is a
 * pointless detour.
 */
export async function fetchMedia(source: string, timeoutMs = 30_000): Promise<Fetched> {
  const trimmed = source.trim();

  if (trimmed.startsWith("data:")) {
    const match = trimmed.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!match) throw new ValidationError("Malformed data: URI.", 400, "(local)", "InvalidRequest");
    const contentType = match[1] || "application/octet-stream";
    const bytes = match[2]
      ? new Uint8Array(Buffer.from(match[3] ?? "", "base64"))
      : new TextEncoder().encode(decodeURIComponent(match[3] ?? ""));
    return { bytes, contentType, source: "data: URI" };
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ValidationError(
      `Media must be a public http(s) URL or a data: URI. Got "${source.slice(0, 80)}".`,
      400,
      "(local)",
      "InvalidRequest",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(trimmed, { signal: controller.signal });
    if (!response.ok) {
      throw new AtpError(
        `Could not fetch media at ${trimmed} (HTTP ${response.status}). It must be reachable without authentication.`,
        response.status,
        "(fetch)",
        "MediaUnreachable",
      );
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
      source: trimmed,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pixel dimensions from the file header, for the embed's `aspectRatio`.
 *
 * Without it Bluesky guesses, and a tall screenshot gets letterboxed into a
 * square in the timeline. PNG, JPEG, GIF and WebP cover essentially everything
 * a post carries; anything else returns undefined and Bluesky falls back to
 * exactly the behaviour it has today.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u8 = bytes;

  // PNG: 8-byte signature, then an IHDR chunk whose width/height are at 16..24.
  if (u8.length > 24 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // GIF: "GIF8", then little-endian width and height.
  if (u8.length > 10 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  // WebP: "RIFF"…"WEBP", then one of three chunk layouts.
  if (
    u8.length > 30 &&
    u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
    u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50
  ) {
    const chunk = String.fromCharCode(u8[12]!, u8[13]!, u8[14]!, u8[15]!);
    if (chunk === "VP8 ") {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      const w = 1 + (u8[24]! | (u8[25]! << 8) | (u8[26]! << 16));
      const h = 1 + (u8[27]! | (u8[28]! << 8) | (u8[29]! << 16));
      return { width: w, height: h };
    }
  }

  // JPEG: walk the segment chain to the SOFn frame header that carries the size.
  if (u8.length > 4 && u8[0] === 0xff && u8[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < u8.length) {
      if (u8[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = u8[offset + 1]!;
      // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15 carry dimensions.
      // DHT (c4), JPG (c8) and DAC (cc) sit in the same range and do not.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      const length = view.getUint16(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
  }

  return undefined;
}

/** Reduce a width/height to the smallest equivalent ratio, which is what the lexicon wants. */
export function aspectRatio(size: { width: number; height: number } | undefined) {
  if (!size || !size.width || !size.height) return undefined;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(size.width, size.height) || 1;
  return { width: Math.round(size.width / d), height: Math.round(size.height / d) };
}

/** Upload an image and return its blob ref plus the aspect ratio to embed with it. */
export async function uploadImage(
  client: BlueskyClient,
  account: Account,
  source: string,
  timeoutMs: number,
): Promise<{ blob: BlobRef; aspectRatio?: { width: number; height: number } }> {
  const media = await fetchMedia(source, timeoutMs);

  if (media.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ValidationError(
      `Image is ${(media.bytes.byteLength / 1e6).toFixed(2)}MB; Bluesky's limit is 1MB. Resize or re-encode it before posting — the server's own error for this does not say what went wrong.`,
      400,
      "com.atproto.repo.uploadBlob",
      "BlobTooLarge",
    );
  }
  if (!media.contentType.startsWith("image/")) {
    throw new ValidationError(
      `${media.source} is ${media.contentType}, not an image.`,
      400,
      "(local)",
      "InvalidRequest",
    );
  }

  const result = await client.call<{ blob: BlobRef }>(account, "com.atproto.repo.uploadBlob", {
    method: "POST",
    blob: { bytes: media.bytes, contentType: media.contentType },
  });

  return { blob: result.blob, aspectRatio: aspectRatio(imageSize(media.bytes)) };
}

type JobStatus = {
  jobId: string;
  did: string;
  state: string;
  progress?: number;
  blob?: BlobRef;
  error?: string;
  failureCode?: string;
  message?: string;
};

/**
 * Upload a video through the transcoding service and wait for the blob.
 *
 * Four steps, and skipping any of them produces a post that looks fine in the
 * API response and plays for nobody:
 *   1. `getUploadLimits` — refuses early when the daily quota is spent
 *   2. `getServiceAuth` scoped to the video service, since it is not the PDS
 *   3. `uploadVideo` — returns a job, not a blob
 *   4. poll `getJobStatus` until the transcode completes
 */
export async function uploadVideo(
  client: BlueskyClient,
  account: Account,
  config: Config,
  source: string,
  onProgress?: (status: JobStatus) => void,
): Promise<BlobRef> {
  const media = await fetchMedia(source, config.requestTimeoutMs);

  if (!media.contentType.startsWith("video/")) {
    throw new ValidationError(
      `${media.source} is ${media.contentType}, not a video.`,
      400,
      "(local)",
      "InvalidRequest",
    );
  }
  if (media.bytes.byteLength > MAX_VIDEO_BYTES) {
    throw new ValidationError(
      `Video is ${(media.bytes.byteLength / 1e6).toFixed(1)}MB, over the ${MAX_VIDEO_BYTES / 1e6}MB the upload service accepts.`,
      400,
      "app.bsky.video.uploadVideo",
      "VideoTooLarge",
    );
  }

  const session = await client.session(account);
  const limitsToken = await client.serviceAuth(
    account,
    config.videoServiceDid,
    "app.bsky.video.getUploadLimits",
  );
  const limits = await client.call<{
    canUpload: boolean;
    message?: string;
    remainingDailyVideos?: number;
    remainingDailyBytes?: number;
  }>(account, "app.bsky.video.getUploadLimits", {
    service: config.videoService,
    token: limitsToken,
  });

  if (!limits.canUpload) {
    throw new ValidationError(
      `Bluesky will not accept a video upload right now: ${limits.message ?? "the daily limit is spent"}.`,
      400,
      "app.bsky.video.getUploadLimits",
      "UploadLimitReached",
    );
  }

  const uploadToken = await client.serviceAuth(
    account,
    config.videoServiceDid,
    "app.bsky.video.uploadVideo",
  );
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.mp4`;
  const started = await client.call<{ jobStatus: JobStatus }>(
    account,
    "app.bsky.video.uploadVideo",
    {
      method: "POST",
      service: config.videoService,
      token: uploadToken,
      query: { did: session.did, name },
      blob: { bytes: media.bytes, contentType: media.contentType },
    },
  );

  let status = started.jobStatus;
  onProgress?.(status);

  // Transcoding a short clip takes seconds; the ceiling is here so a stuck job
  // fails with an explanation instead of holding the tool call open forever.
  const deadline = Date.now() + 5 * 60_000;
  while (status.state !== "JOB_STATE_COMPLETED" && status.state !== "JOB_STATE_FAILED") {
    if (Date.now() > deadline) {
      throw new AtpError(
        `Video is still ${status.state} after 5 minutes. Job ${status.jobId} may still finish; check it with get_video_job_status.`,
        408,
        "app.bsky.video.getJobStatus",
        "Timeout",
      );
    }
    await delay(2_000);
    const polled = await client.call<{ jobStatus: JobStatus }>(
      account,
      "app.bsky.video.getJobStatus",
      { service: config.videoService, token: uploadToken, query: { jobId: status.jobId } },
    );
    status = polled.jobStatus;
    onProgress?.(status);
  }

  if (status.state === "JOB_STATE_FAILED" || !status.blob) {
    throw new AtpError(
      `Bluesky could not process the video: ${status.error ?? status.message ?? status.failureCode ?? "unknown failure"}.`,
      400,
      "app.bsky.video.uploadVideo",
      status.failureCode ?? "VideoProcessingFailed",
    );
  }

  return status.blob;
}
