import type {
  AssetRef,
  CloudinaryClient,
  StoredAsset,
  UploadInput,
} from '../../lib/cloudinary.js';

/** In-memory stand-in for Cloudinary so tests never touch the network. */
export function createFakeCloudinary() {
  const uploads: UploadInput[] = [];
  const destroyed: AssetRef[] = [];

  const client: CloudinaryClient = {
    async upload(input): Promise<StoredAsset> {
      uploads.push(input);
      return {
        publicId: input.publicId,
        resourceType: input.resourceType,
        deliveryType: input.deliveryType,
        format: input.mimeType === 'application/pdf' ? 'pdf' : 'jpg',
        bytes: input.buffer.length,
        width: input.resourceType === 'image' ? 640 : null,
        height: input.resourceType === 'image' ? 480 : null,
      };
    },
    async destroy(ref) {
      destroyed.push(ref);
    },
    privateDownloadUrl: (ref, ttl) => `https://fake.test/download/${ref.publicId}?ttl=${ttl}`,
    publicUrl: (publicId, width) => `https://fake.test/${width ?? 'full'}/${publicId}`,
  };

  return { client, uploads, destroyed };
}

export const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
export const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
]);
export const PDF_BYTES = Buffer.from('%PDF-1.4\n%fake evidence\n');
