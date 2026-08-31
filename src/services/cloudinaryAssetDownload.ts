import { cloudinary } from '../config/cloudinary';

export type ParsedCloudinaryDeliveryUrl = {
  cloud: string;
  resourceType: 'image' | 'raw' | 'video';
  deliveryType: string;
  publicId: string;
  format?: string;
  version?: string;
};

function ensureCloudinaryConfigured(): void {
  // Server normally calls cloudinaryConnect() at boot; re-apply here so
  // authenticated downloads work even if that path was skipped in tests.
  cloudinary.config({
    cloud_name: process.env.CLOUD_NAME,
    api_key: process.env.API_KEY,
    api_secret: process.env.API_SECRET,
    secure: true,
  });
}

/**
 * Parse a standard Cloudinary delivery URL into public_id + format.
 * Supports common delivery paths without (or with simple) transformations:
 *   /{cloud}/{image|raw|video}/{type}/[v{version}/]{public_id}[.{format}]
 */
export function parseCloudinaryDeliveryUrl(
  rawUrl: string,
): ParsedCloudinaryDeliveryUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl ?? '').trim());
  } catch {
    return null;
  }
  if (parsed.hostname !== 'res.cloudinary.com') return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 4) return null;

  const cloud = segments[0];
  const resourceType = segments[1];
  const deliveryType = segments[2];
  if (!cloud || !['image', 'raw', 'video'].includes(resourceType)) return null;
  if (!deliveryType) return null;

  let rest = segments.slice(3);

  // Skip signed-url / transformation segments until version or public_id.
  // e.g. s--xxxx--, c_fill,w_100, fl_attachment
  while (rest.length > 0) {
    const seg = rest[0];
    if (/^v\d+$/i.test(seg)) break;
    // Heuristic: transformation segments contain `,` or start with known prefixes / s--
    if (
      seg.includes(',') ||
      /^s--/.test(seg) ||
      /^(c_|w_|h_|f_|q_|fl_|t_|l_|e_|b_|a_|d_|o_|r_|u_|x_|y_)/i.test(seg)
    ) {
      rest = rest.slice(1);
      continue;
    }
    break;
  }

  let version: string | undefined;
  if (rest[0] && /^v\d+$/i.test(rest[0])) {
    version = rest[0].slice(1);
    rest = rest.slice(1);
  }

  if (!rest.length) return null;

  const last = rest[rest.length - 1];
  const formatMatch = last.match(/\.([a-z0-9]+)$/i);
  let format = formatMatch?.[1]?.toLowerCase();
  const publicIdParts = [...rest];
  if (formatMatch) {
    publicIdParts[publicIdParts.length - 1] = last.replace(/\.[a-z0-9]+$/i, '');
  }

  const publicId = publicIdParts.join('/');
  if (!publicId) return null;

  // PDFs stored as Cloudinary image resources often omit an extension in public_id
  // but keep `.pdf` on the delivery URL — prefer that format.
  if (!format && resourceType === 'image') {
    format = undefined;
  }

  return {
    cloud,
    resourceType: resourceType as 'image' | 'raw' | 'video',
    deliveryType,
    publicId,
    format,
    version,
  };
}

function isOurCloudinaryCloud(cloud: string): boolean {
  const ours = String(process.env.CLOUD_NAME || '').trim();
  return Boolean(ours) && ours === cloud;
}

async function fetchOkBuffer(url: string): Promise<Buffer | null> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length ? buf : null;
}

function withPdfExtension(url: string): string | null {
  const href = String(url || '').trim();
  if (!href) return null;
  if (/\.pdf(\?|#|$)/i.test(href)) return null;
  try {
    const parsed = new URL(href);
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}.pdf`;
    return parsed.toString();
  } catch {
    return `${href}.pdf`;
  }
}

async function downloadViaSignedOrPrivate(args: {
  publicId: string;
  format: string;
  resourceType: 'image' | 'raw' | 'video';
  deliveryType: string;
}): Promise<Buffer | null> {
  ensureCloudinaryConfigured();
  const { publicId, format, resourceType, deliveryType } = args;

  const signedUrl = cloudinary.url(publicId, {
    resource_type: resourceType,
    type: deliveryType,
    format,
    sign_url: true,
    secure: true,
  });
  const signedBuf = await fetchOkBuffer(signedUrl);
  if (signedBuf) return signedBuf;

  const privateUrl = cloudinary.utils.private_download_url(publicId, format, {
    resource_type: resourceType,
    type: deliveryType,
    attachment: false,
  });
  return fetchOkBuffer(privateUrl);
}

async function downloadAuthenticatedCloudinaryAsset(
  parsed: Pick<ParsedCloudinaryDeliveryUrl, 'publicId' | 'format' | 'resourceType' | 'deliveryType'>,
): Promise<Buffer | null> {
  const format = parsed.format || 'pdf';
  const resourceTypes: Array<'image' | 'raw'> =
    parsed.resourceType === 'raw' ? ['raw', 'image'] : ['image', 'raw'];
  const deliveryTypes = Array.from(
    new Set(
      [parsed.deliveryType || 'upload', 'upload', 'authenticated', 'private'].filter(Boolean),
    ),
  );

  for (const resourceType of resourceTypes) {
    for (const deliveryType of deliveryTypes) {
      const buf = await downloadViaSignedOrPrivate({
        publicId: parsed.publicId,
        format,
        resourceType,
        deliveryType,
      });
      if (buf) return buf;
    }
  }

  ensureCloudinaryConfigured();
  for (const resourceType of resourceTypes) {
    try {
      const resource = await cloudinary.api.resource(parsed.publicId, {
        resource_type: resourceType,
      });
      const buf = await downloadViaSignedOrPrivate({
        publicId: String(resource.public_id || parsed.publicId),
        format: String(resource.format || format),
        resourceType: (resource.resource_type as 'image' | 'raw') || resourceType,
        deliveryType: String(resource.type || 'upload'),
      });
      if (buf) return buf;
    } catch {
      /* try the other resource type */
    }
  }

  return null;
}

/**
 * Download by Cloudinary public_id when the stored delivery URL is 401 / missing `.pdf`.
 */
export async function fetchCloudinaryAssetByPublicId(
  publicId: string,
  options?: { resourceType?: 'image' | 'raw'; format?: string },
): Promise<Buffer> {
  const pid = String(publicId || '').trim().replace(/\.[a-z0-9]+$/i, '');
  if (!pid) {
    throw new Error('Cloudinary public_id is required');
  }
  const buf = await downloadAuthenticatedCloudinaryAsset({
    publicId: pid,
    format: options?.format || 'pdf',
    resourceType: options?.resourceType || 'image',
    deliveryType: 'upload',
  });
  if (!buf?.length) {
    throw new Error('Could not fetch Cloudinary asset via public_id');
  }
  return buf;
}

/**
 * Download a Cloudinary asset as a Buffer.
 * Public delivery URLs on this account currently return 401 (ACL / restricted media),
 * so fall back to a signed URL / authenticated Admin API download for our cloud.
 */
export async function fetchCloudinaryAssetBuffer(rawUrl: string): Promise<Buffer> {
  const url = String(rawUrl ?? '').trim();
  if (!url) {
    throw new Error('Cloudinary URL is required');
  }

  const publicCandidates = [url];
  const pdfUrl = withPdfExtension(url);
  if (pdfUrl) publicCandidates.push(pdfUrl);

  let lastPublicStatus = 0;
  for (const candidate of publicCandidates) {
    const publicRes = await fetch(candidate, { redirect: 'follow' });
    if (publicRes.ok) {
      return Buffer.from(await publicRes.arrayBuffer());
    }
    lastPublicStatus = publicRes.status;
  }

  const parsed =
    parseCloudinaryDeliveryUrl(url) ||
    (pdfUrl ? parseCloudinaryDeliveryUrl(pdfUrl) : null);
  if (!parsed || !isOurCloudinaryCloud(parsed.cloud)) {
    throw new Error(`Could not fetch Cloudinary asset (${lastPublicStatus || 'unknown'})`);
  }

  const buf = await downloadAuthenticatedCloudinaryAsset(parsed);
  if (!buf?.length) {
    throw new Error(
      `Could not fetch Cloudinary asset via authenticated download (${lastPublicStatus || 'unknown'})`,
    );
  }
  return buf;
}
