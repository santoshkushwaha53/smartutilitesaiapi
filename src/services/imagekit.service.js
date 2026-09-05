const ImageKit = require("imagekit");

function configured() {
  return Boolean(
    process.env.IMAGEKIT_PUBLIC_KEY &&
      process.env.IMAGEKIT_PRIVATE_KEY &&
      process.env.IMAGEKIT_URL_ENDPOINT
  );
}

function client() {
  if (!configured()) {
    const err = new Error(
      "ImageKit is not configured. Set IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY, and IMAGEKIT_URL_ENDPOINT."
    );
    err.status = 503;
    throw err;
  }

  return new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
  });
}

/**
 * Upload a binary image buffer to ImageKit and return the CDN URL payload.
 * @param {{ buffer: Buffer, originalname: string, mimetype?: string }} file
 * @param {{ folder?: string }} [opts]
 */
async function uploadImage(file, opts = {}) {
  if (!file?.buffer?.length) {
    const err = new Error("No file uploaded");
    err.status = 400;
    throw err;
  }

  const folder = opts.folder || process.env.IMAGEKIT_FOLDER || "/indiaph/articles";
  const safeName = String(file.originalname || "image")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);

  const imagekit = client();
  const result = await imagekit.upload({
    file: file.buffer,
    fileName: `${Date.now()}-${safeName}`,
    folder,
    useUniqueFileName: true,
  });

  return {
    url: result.url,
    thumbnailUrl: result.thumbnailUrl || result.url,
    fileId: result.fileId,
    filename: result.name,
    originalName: file.originalname,
    size: file.buffer.length,
    width: result.width,
    height: result.height,
    provider: "imagekit",
  };
}

module.exports = {
  configured,
  uploadImage,
};
