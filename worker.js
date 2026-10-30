export default {
    async fetch(request, env, ctx) {
        const startTime = performance.now();

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, X-RapidAPI-Key, X-RapidAPI-Host, X-RapidAPI-Proxy-Secret',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        const expectedSecret = env.RAPIDAPI_PROXY_SECRET;
        if (expectedSecret) {
            const incomingSecret = request.headers.get('X-RapidAPI-Proxy-Secret');
            if (incomingSecret !== expectedSecret) {
                return jsonResponse({
                    error: 'Unauthorized',
                    message: 'Invalid or missing RapidAPI proxy secret.',
                }, 403);
            }
        }

        const url = new URL(request.url);

        if (url.pathname === '/' || url.pathname === '/v1/health') {
            return jsonResponse({
                status: 'healthy',
                service: 'LLM-Ready Web-to-Markdown & Metadata API',
                version: '1.0.0',
                edgeRegion: request.cf?.colo || 'UNKNOWN',
                timestamp: new Date().toISOString(),
            }, 200);
        }

        let targetUrl = '';
        let options = {
            includeMarkdown: true,
            includeJsonLd: true,
            includeMetadata: true,
            includeEmails: true,
            maxContentLength: 50000,
        };

        if (request.method === 'POST') {
            try {
                const body = await request.json();
                targetUrl = body.url || '';
                if (body.options) {
                    options = { ...options, ...body.options };
                }
            } catch {
                return jsonResponse({ error: 'Bad Request', message: 'Malformed JSON payload.' }, 400);
            }
        } else if (request.method === 'GET') {
            targetUrl = url.searchParams.get('url') || '';
            if (url.searchParams.has('includeMarkdown')) {
                options.includeMarkdown = url.searchParams.get('includeMarkdown') === 'true';
            }
            if (url.searchParams.has('includeEmails')) {
                options.includeEmails = url.searchParams.get('includeEmails') === 'true';
            }
        } else {
            return jsonResponse({ error: 'Method Not Allowed', message: 'Only GET and POST methods are supported.' }, 405);
        }

        if (!targetUrl) {
            return jsonResponse({
                error: 'Bad Request',
                message: 'Missing required parameter: "url". Example: "https://example.com"',
            }, 400);
        }

        let parsedTarget;
        try {
            parsedTarget = new URL(targetUrl);
            if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
                throw new Error('Unsupported protocol');
            }
        } catch {
            return jsonResponse({
                error: 'Bad Request',
                message: 'Invalid URL. Must include http:// or https:// scheme.',
            }, 400);
        }

        const fetchStart = performance.now();
        let targetResponse;
        try {
            targetResponse = await fetch(parsedTarget.toString(), {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 (compatible; LLM-Extractor/1.0)',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                redirect: 'follow',
                cf: {
                    cacheTtl: 300,
                    cacheEverything: true,
                },
            });
        } catch (fetchErr) {
            return jsonResponse({
                error: 'Upstream Fetch Failed',
                message: `Could not reach target URL: ${fetchErr.message}`,
            }, 502);
        }

        const fetchTimeMs = Math.round(performance.now() - fetchStart);

        if (!targetResponse.ok) {
            return jsonResponse({
                error: 'Upstream Error',
                statusCode: targetResponse.status,
                message: `Target server responded with HTTP ${targetResponse.status} ${targetResponse.statusText}`,
            }, 502);
        }

        const rawHtml = await targetResponse.text();
        const procStart = performance.now();

        const metadata = options.includeMetadata ? extractMetadata(rawHtml, parsedTarget.toString()) : null;
        const jsonLd = options.includeJsonLd ? extractJsonLd(rawHtml) : [];
        const emails = options.includeEmails ? extractEmails(rawHtml) : [];
        let markdown = '';
        if (options.includeMarkdown) {
            markdown = htmlToMarkdown(rawHtml, options.maxContentLength);
        }

        const processingTimeMs = Math.round(performance.now() - procStart);
        const totalLatencyMs = Math.round(performance.now() - startTime);
        const wordCount = markdown ? markdown.trim().split(/\s+/).length : 0;
        const charCount = markdown ? markdown.length : 0;

        return jsonResponse({
            success: true,
            url: parsedTarget.toString(),
            metadata,
            emails,
            jsonLd,
            markdown,
            metrics: {
                wordCount,
                characterCount: charCount,
                estimatedLlmTokens: Math.round(charCount / 4),
                fetchTimeMs,
                processingTimeMs,
                totalLatencyMs,
            },
        }, 200);
    },
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=60',
        },
    });
}

function extractMetadata(html, fallbackUrl) {
    const getTag = (pattern) => {
        const m = html.match(pattern);
        return m ? m[1].trim() : null;
    };

    const title = getTag(/<title[^>]*>([^<]+)<\/title>/i) ||
                  getTag(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                  getTag(/<meta[^>]*name=["']twitter:title["'][^>]*content=["']([^"']+)["']/i);

    const description = getTag(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                        getTag(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
                        getTag(/<meta[^>]*name=["']twitter:description["'][^>]*content=["']([^"']+)["']/i);

    const ogImage = getTag(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    const ogSiteName = getTag(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i);
    const canonical = getTag(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || fallbackUrl;
    const language = getTag(/<html[^>]*lang=["']([^"']+)["']/i) || 'en';

    return {
        title,
        description,
        canonicalUrl: canonical,
        siteName: ogSiteName,
        previewImage: ogImage,
        language,
    };
}

function extractJsonLd(html) {
    const results = [];
    const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
        try {
            const parsed = JSON.parse(match[1].trim());
            if (Array.isArray(parsed)) {
                results.push(...parsed);
            } else {
                results.push(parsed);
            }
        } catch {
            // Ignore malformed JSON-LD scripts
        }
    }
    return results;
}

function extractEmails(html) {
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const badExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.css', '.js'];
    const badDomains = ['example.com', 'domain.com', 'sentry.io', 'w3.org'];

    const matches = html.match(emailRegex) || [];
    const unique = new Set();
    for (const em of matches) {
        const lower = em.toLowerCase().trim();
        if (!badExts.some((ext) => lower.endsWith(ext)) && !badDomains.some((d) => lower.includes(d))) {
            unique.add(lower);
        }
    }
    return Array.from(unique);
}

function htmlToMarkdown(rawHtml, maxLen = 50000) {
    let text = rawHtml;
    text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
    text = text.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '');
    text = text.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');
    text = text.replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '');
    text = text.replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '');
    text = text.replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, '');

    text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n');
    text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n');
    text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n');
    text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n\n');
    text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n\n##### $1\n\n');
    text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n\n###### $1\n\n');

    text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
    text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
    text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n\n```\n$1\n```\n\n');
    text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

    text = text.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (match, href, anchorText) => {
        const cleanAnchor = anchorText.replace(/<[^>]+>/g, '').trim();
        if (!cleanAnchor || href.startsWith('javascript:')) return cleanAnchor;
        return `[${cleanAnchor}](${href})`;
    });

    text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');
    text = text.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
    text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n');
    text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n');
    text = text.replace(/<br\s*[\/]?>/gi, '\n');
    text = text.replace(/<hr\s*[\/]?>/gi, '\n\n---\n\n');

    text = text.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (match, rowContent) => {
        const cells = [];
        const cellRegex = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi;
        let c;
        while ((c = cellRegex.exec(rowContent)) !== null) {
            cells.push(c[2].replace(/<[^>]+>/g, '').trim());
        }
        return `| ${cells.join(' | ')} |\n`;
    });
    text = text.replace(/<\/?(table|thead|tbody)[^>]*>/gi, '\n');
    text = text.replace(/<[^>]+>/g, '');

    text = text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');

    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n\s*\n\s*\n+/g, '\n\n');

    return text.trim().slice(0, maxLen);
}
