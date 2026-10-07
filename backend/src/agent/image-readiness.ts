/** Broken optional images may be removed/hidden by their renderer; visible failures remain errors. */
export const IMAGE_READINESS = `Promise.all(Array.from(document.images, image => image.decode().catch(error => {
  if (image.isConnected && image.getClientRects().length && getComputedStyle(image).visibility !== 'hidden') {
    throw new Error('Visible widget image failed to decode: ' + error.message);
  }
})))`;
