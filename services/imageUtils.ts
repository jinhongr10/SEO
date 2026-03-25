/**
 * Reads a File object and returns an HTMLImageElement and dimensions.
 */
export const loadImage = (file: File): Promise<{ img: HTMLImageElement; width: number; height: number }> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      resolve({ img, width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url); // Cleanup handled inside if needed, but we might need the object URL for canvas
    };
    img.onerror = (e) => reject(e);
    img.src = url;
  });
};

/**
 * Resizes an image and converts it to WebP using Canvas.
 */
export const processImageToWebP = async (
  file: File,
  targetWidth: number,
  quality = 0.75
): Promise<{ blob: Blob; width: number; height: number }> => {
  const { img, width, height } = await loadImage(file);

  // Calculate new dimensions
  let newWidth = width;
  let newHeight = height;

  if (targetWidth > 0 && width > targetWidth) {
    newWidth = targetWidth;
    newHeight = Math.round((height / width) * targetWidth);
  }

  const canvas = document.createElement('canvas');
  canvas.width = newWidth;
  canvas.height = newHeight;
  const ctx = canvas.getContext('2d');

  if (!ctx) throw new Error('Could not get canvas context');

  // Better resizing quality
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, newWidth, newHeight);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve({ blob, width: newWidth, height: newHeight });
        } else {
          reject(new Error('Canvas to Blob failed'));
        }
      },
      'image/webp',
      quality
    );
  });
};

export const formatBytes = (bytes: number, decimals = 2) => {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GiB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};
