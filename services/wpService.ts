import { SEOData, WPData } from "../types";

export const uploadToWordPress = async (
  url: string,
  user: string,
  appPass: string,
  blob: Blob,
  seo: SEOData,
  useProxy: boolean = false,
  backendUrl?: string
): Promise<WPData> => {
  // Option 1: Backend Proxy Mode (FastAPI)
  if (useProxy) {
    const proxyBase = ((backendUrl || '/api').trim() || '/api').replace(/\/$/, '');
    const formData = new FormData();
    formData.append('file', blob, seo.filename);
    formData.append('seoData', JSON.stringify(seo));
    if (url) formData.append('wpUrl', url);
    if (user) formData.append('wpUser', user);
    if (appPass) formData.append('wpAppPass', appPass);

    let res: Response;
    try {
      res = await fetch(`${proxyBase}/wp/upload`, {
        method: 'POST',
        body: formData,
      });
    } catch (e: any) {
      throw new Error(`Cannot reach backend upload API (${proxyBase}/wp/upload): ${e?.message || 'Network error'}`);
    }

    if (!res.ok) {
      let errorMessage = await res.text();
      try {
        const json = JSON.parse(errorMessage);
        errorMessage = json.detail || json.error || json.message || errorMessage;
      } catch (e) { /* keep text error */ }
      throw new Error(`Proxy Upload Failed: ${errorMessage}`);
    }

    return await res.json();
  }

  // Option 2: Direct Client Mode (Standard)
  // Normalize URL
  const baseUrl = url.replace(/\/$/, '');
  const endpoint = `${baseUrl}/wp-json/wp/v2/media`;
  
  // Basic Auth
  const token = btoa(`${user}:${appPass}`);
  const headers = {
    'Authorization': `Basic ${token}`,
    // Content-Disposition tells WP the filename
    'Content-Disposition': `attachment; filename="${seo.filename}"`,
    'Content-Type': blob.type || 'image/webp',
  };

  // Step 1: Upload the binary
  let mediaId: number;
  let sourceUrl: string;
  let link: string;

  try {
    const uploadRes = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: blob,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.json();
      throw new Error(`WP Upload Failed: ${err.message || uploadRes.statusText}`);
    }

    const uploadData = await uploadRes.json();
    mediaId = uploadData.id;
    sourceUrl = uploadData.source_url;
    link = uploadData.link; // The attachment page or direct link depending on WP config
  } catch (e: any) {
    throw new Error(`Connection Error: ${e.message}. Check CORS or Credentials.`);
  }

  // Step 2: Update Metadata (Title, Alt, etc.)
  try {
    const updateRes = await fetch(`${endpoint}/${mediaId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: seo.title,
        caption: seo.caption,
        alt_text: seo.alt,
        description: seo.description,
      }),
    });

    if (!updateRes.ok) {
      console.warn("Metadata update failed, but image uploaded.");
    }
  } catch (e) {
    console.warn("Metadata update network error", e);
  }

  return {
    id: mediaId,
    source_url: sourceUrl,
    link: link
  };
};
