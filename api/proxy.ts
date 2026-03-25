// Intended for Next.js App Router or Edge Function
// Since we don't have direct access to 'next/server' in the browser preview,
// we use standard Web API interfaces which are compatible with Next.js App Router.

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as Blob;
    const wpUrl = formData.get('wpUrl') as string;
    const wpUser = formData.get('wpUser') as string;
    const wpAppPass = formData.get('wpAppPass') as string;
    const seoDataString = formData.get('seoData') as string;
    
    if (!file || !wpUrl || !wpUser || !wpAppPass) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const seo = JSON.parse(seoDataString || '{}');
    const token = btoa(`${wpUser}:${wpAppPass}`);
    const baseUrl = wpUrl.replace(/\/$/, '');
    
    // 1. Upload Media
    const uploadRes = await fetch(`${baseUrl}/wp-json/wp/v2/media`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${token}`,
        'Content-Disposition': `attachment; filename="${seo.filename || 'image.webp'}"`,
        'Content-Type': 'image/webp',
      },
      body: file,
    });

    if (!uploadRes.ok) {
       const err = await uploadRes.json();
       throw new Error(err.message || uploadRes.statusText);
    }
    
    const uploadData = await uploadRes.json();
    const mediaId = uploadData.id;

    // 2. Update Metadata
    if (mediaId && seo.title) {
       await fetch(`${baseUrl}/wp-json/wp/v2/media/${mediaId}`, {
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
    }

    return new Response(JSON.stringify(uploadData), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}