const MAX_SIDE = 800
const JPEG_QUALITY = 0.7
export const MAX_IMAGES = 3

export async function compressImage(file: File): Promise<string> {
  const img = await createImageBitmap(file)
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height))
  const w = Math.round(img.width * scale)
  const h = Math.round(img.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, w, h)
  img.close()

  return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
}
