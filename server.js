const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

function cleanCoverUrl(url) {
  if (url) {
    return url.split('?')[0];
  }
  return url;
}

// Parse ISO-8601 duration (e.g. "PT6H45M" from JSON-LD) into minutes
function parseIsoDuration(iso) {
  if (!iso || typeof iso !== 'string') return undefined;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!m) return undefined;
  const hours = parseInt(m[1] || '0', 10);
  const minutes = parseInt(m[2] || '0', 10);
  const total = hours * 60 + minutes;
  return total > 0 ? total : undefined;
}

// Extract the schema.org Product/Audiobook JSON-LD object embedded in product pages.
// This is the most future-proof data source - it is kept for SEO and does not
// depend on hashed CSS class names.
function extractProductJsonLd($) {
  let product = null;
  $('script[type="application/ld+json"]').each((i, el) => {
    if (product) return;
    try {
      const parsed = JSON.parse($(el).contents().text());
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        const types = [].concat(node && node['@type'] ? node['@type'] : []);
        if (types.includes('Audiobook') || types.includes('Product')) {
          product = node;
          return;
        }
      }
    } catch (e) {
      // ignore malformed JSON-LD blocks
    }
  });
  return product;
}

// Look up a value in the <dt>/<dd> details list by label (e.g. "Głosy", "Długość").
// Returns the <dd> cheerio element or null.
function ddForLabel($, labels) {
  let result = null;
  $('dt').each((i, el) => {
    if (result) return;
    const text = $(el).text().trim();
    if (labels.includes(text)) {
      const dd = $(el).next('dd');
      if (dd.length) result = dd;
    }
  });
  return result;
}

function textOrJoinedLinks($, el) {
  if (!el || !el.length) return '';
  const links = el.find('a');
  if (links.length > 0) {
    return links.map((i, a) => $(a).text().trim()).get().filter(Boolean).join(', ');
  }
  return el.text().trim();
}

function parseDuration(durationStr) {
  if (!durationStr) return undefined;

  let hours = 0;
  let minutes = 0;

  // Use the regex provided by the user, REMOVED 'g' and 'm' flags
  const durationRegex = /^(?:(\d+)\s+[^\d\s]+)?\s*(?:(\d+)\s+[^\d\s]+)$/; 
  // No need to reset lastIndex without the 'g' flag
  const matches = durationStr.match(durationRegex);

  // Check if the regex matched successfully
  // Without 'g', matches will be null if no match, or an array like:
  // [fullMatch, captureGroup1, captureGroup2, ...]
  if (matches) { 
    // matches[1] is the hours capture group (optional)
    // matches[2] is the minutes capture group (mandatory part of the pattern)
    
    if (matches[1]) { // Check if hours group was captured
      hours = parseInt(matches[1], 10);
    }
    // matches[2] should exist if matches is not null, based on the regex structure
    if (matches[2]) { 
      minutes = parseInt(matches[2], 10);
    }
  } else {
      // Log if the regex failed to match
      if (durationStr.trim()) {
        console.warn(`Could not parse duration string using provided regex: "${durationStr}"`);
      }
      // Consider if a fallback or different handling is needed for strings
      // that don't match (e.g., only hours "1 hodina")
      return undefined; // Return undefined if parsing fails
  }

  // Ensure we have valid numbers, default to 0 if parseInt resulted in NaN
  if (isNaN(hours)) hours = 0;
  if (isNaN(minutes)) minutes = 0;

  // Return total duration in minutes
  const durationInMinutes = (hours * 60) + minutes;
  // Keep the log to confirm output
  console.log(`Parsed duration in minutes for "${durationStr}": ${durationInMinutes}`);
  return durationInMinutes;
}

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());

// Middleware to check for AUTHORIZATION header
app.use((req, res, next) => {
  const apiKey = req.headers['authorization'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // part to validate API
  next();
});

const language = process.env.LANGUAGE || 'pl';  // Default to Polish if not specified
const addAudiotekaLinkToDescription = (process.env.ADD_AUDIOTEKA_LINK_TO_DESCRIPTION || 'true').toLowerCase() === 'true';
// Metadata fetch concurrency (configurable via env var). Default to 5 when not provided or invalid.
const DEFAULT_METADATA_CONCURRENCY = 5;
const metadataConcurrency = (() => {
  const v = parseInt(process.env.METADATA_CONCURRENCY, 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_METADATA_CONCURRENCY;
})();

// Browser-like headers.
// IMPORTANT: audioteka.com (Next.js) returns an empty page shell (no search results)
// when the request does not contain a browser-like "Accept: text/html..." header.
// Axios sends "Accept: application/json, text/plain, */*" by default, which broke scraping.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function browserHeaders() {
  return {
    ...BROWSER_HEADERS,
    'Accept-Language': language === 'cz' ? 'cs-CZ,cs;q=0.9' : 'pl-PL,pl;q=0.9',
  };
}

class AudiotekaProvider {
  constructor() {
    this.id = 'audioteka';
    this.name = 'Audioteka';
    this.baseUrl = 'https://audioteka.com';
    // Trailing slash is required now - non-slash URLs respond with a redirect
    this.searchUrl = language === 'cz' ? 'https://audioteka.com/cz/vyhledavani/' : 'https://audioteka.com/pl/szukaj/';
  }

  async searchBooks(query, author = '', requestId = 'req') {
    try {
      console.log(`[${requestId}] Searching for: "${query}" by "${author}"`);
      const searchUrl = `${this.searchUrl}?phrase=${encodeURIComponent(query)}`;
      
      const response = await axios.get(searchUrl, {
        headers: browserHeaders()
      });
      const $ = cheerio.load(response.data);

  console.log(`[${requestId}] Search URL:`, searchUrl);

      const matches = [];
      // Class name hashes (e.g. teaser_teaser__FDajW) change on Audioteka deployments,
      // and the old stable class "adtk-item" was removed - match on the stable
      // CSS-module prefix instead of the full hashed class name.
      const $books = $('li[class*="teaser_teaser__"], .adtk-item[class*="teaser_teaser__"]');
  console.log(`[${requestId}] Number of books found:`, $books.length);

      $books.each((index, element) => {
        const $book = $(element);

        const title = $book.find('[class*="teaser_title__"]').first().text().trim();
        const href = $book.find('a[class*="teaser_link__"]').attr('href') || $book.find('a[href*="/audiobook/"]').attr('href');
        if (!href) return;
        const bookUrl = this.baseUrl + href;
        const authors = [$book.find('[class*="teaser_author__"]').first().text().trim()];
        // Cover <img> may be wrapped in <noscript> (lazy loading) - cheerio does not
        // parse <noscript> content as HTML, so fall back to extracting src via regex.
        let coverSrc = $book.find('img[class*="teaser_coverImage__"]').attr('src');
        if (!coverSrc) {
          const noscriptHtml = $book.find('noscript').html() || $book.find('noscript').text() || '';
          const srcMatch = noscriptHtml.match(/src="([^"]+)"/);
          if (srcMatch) coverSrc = srcMatch[1].replace(/&amp;/g, '&');
        }
        const cover = cleanCoverUrl(coverSrc);
        const rating = parseFloat($book.find('[class*="teaser-footer_rating__"]').first().text().trim()) || null;

        const id = $book.attr('data-item-id') || bookUrl.replace(/\/+$/, '').split('/').pop();

        if (title && bookUrl && authors.length > 0) {
          matches.push({
            id,
            title,
            authors,
            url: bookUrl,
            cover,
            rating,
            source: {
              id: this.id,
              description: this.name,
              link: this.baseUrl,
            },
          });
        }
      });

  // Fetch full metadata with limited concurrency to avoid overloading the site
  const fullMetadata = await this.mapWithConcurrency(matches, match => this.getFullMetadata(match, requestId), metadataConcurrency);
      
      // Filter out null results (non-Czech books for Czech users)
      const filteredMetadata = fullMetadata.filter(book => book !== null);
      
  console.log(`[${requestId}] Filtered ${fullMetadata.length - filteredMetadata.length} non-Czech books`);
      
      return { matches: filteredMetadata };
    } catch (error) {
      console.error(`[${requestId}] Error searching books:`, error.message, error.stack);
      return { matches: [] };
    }
  }
  // Helper to map over items with limited concurrency
  async mapWithConcurrency(items, iteratorFn, limit = 5) {
    const results = new Array(items.length);
    let i = 0;
    const workers = Array(Math.min(limit, items.length)).fill().map(async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        try {
          results[idx] = await iteratorFn(items[idx]);
        } catch (err) {
          // keep error isolated per-item
          console.error('Error in mapWithConcurrency item:', err && err.message || err);
          results[idx] = null;
        }
      }
    });
    await Promise.all(workers);
    return results;
  }
  async getFullMetadata(match) {
    try {
      // backward compatible when requestId is not passed
      let requestId = 'req';
      // if caller passed a requestId as second arg, it will be available in arguments
      if (arguments.length >= 2 && arguments[1]) requestId = arguments[1];
      console.log(`[${requestId}] Fetching full metadata for: ${match.title}`);
      const response = await axios.get(match.url, { headers: browserHeaders() });
      const $ = cheerio.load(response.data);

      // Primary data source: schema.org Product/Audiobook JSON-LD embedded in the page.
      // Secondary: the <dt>/<dd> details list. Legacy selectors kept as last resort.
      const ld = extractProductJsonLd($);
      if (ld) {
        console.log(`[${requestId}] Found product JSON-LD for: ${match.title}`);
      }

      const narratorLabels = language === 'cz' ? ['Interpret', 'Čte'] : ['Głosy', 'Lektor'];
      const durationLabels = language === 'cz' ? ['Délka', 'Stopáž'] : ['Długość'];
      const publisherLabels = language === 'cz' ? ['Vydavatel', 'Nakladatel'] : ['Wydawca'];
      const genreLabels = language === 'cz' ? ['Kategorie', 'Žánr'] : ['Kategoria'];
      const languageLabels = language === 'cz' ? ['Jazyk'] : ['Język'];
      const seriesLabels = language === 'cz' ? ['Cyklus', 'Série'] : ['Cykl', 'Seria'];

      // --- Narrator ---
      let narrators = '';
      if (ld && ld.readBy) {
        narrators = [].concat(ld.readBy).map(p => (p && p.name) || '').filter(Boolean).join(', ');
      }
      if (!narrators) {
        narrators = textOrJoinedLinks($, ddForLabel($, narratorLabels));
      }
      if (!narrators) {
        // Legacy fallbacks (old table/div based layouts)
        narrators = $('.product-table tr:contains("Głosy") td:last-child a, table tr:contains("Interpret") td:last-child a')
          .map((i, el) => $(el).text().trim()).get().join(', ');
      }
      // If we still have concatenated names without separators, try to add commas
      if (narrators && !narrators.includes(',') && narrators.match(/[A-ZĄĆĘŁŃÓŚŹŻÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-ząćęłńóśźżáčďéěíňóřšťúůýž]+[A-ZĄĆĘŁŃÓŚŹŻÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/)) {
        narrators = narrators.replace(/([a-ząćęłńóśźżáčďéěíňóřšťúůýž])([A-ZĄĆĘŁŃÓŚŹŻÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ])/g, '$1, $2');
      }
      console.log(`[${requestId}] Narrator extracted: "${narrators}"`);

      // --- Duration ---
      const durationDd = ddForLabel($, durationLabels);
      let durationStr = durationDd ? durationDd.text().trim() : '';
      if (!durationStr) {
        durationStr = $('.product-table tr:contains("Długość") td:last-child').text().trim();
      }
      let durationInMinutes = parseDuration(durationStr);
      if (durationInMinutes === undefined && ld && ld.duration) {
        durationInMinutes = parseIsoDuration(ld.duration);
        console.log(`[${requestId}] Duration from JSON-LD (${ld.duration}): ${durationInMinutes} min`);
      }

      // --- Publisher ---
      let publisher = textOrJoinedLinks($, ddForLabel($, publisherLabels));
      if (!publisher && ld && ld.brand) {
        publisher = [].concat(ld.brand).map(b => (b && b.name) || '').filter(Boolean).join(', ');
      }
      if (!publisher) {
        publisher = $('.product-table tr:contains("Wydawca") td:last-child').text().trim();
      }
      console.log(`[${requestId}] Publisher extracted: "${publisher}"`);

      // --- Type ---
      let type = textOrJoinedLinks($, ddForLabel($, ['Typ']));
      if (!type) {
        type = $('.product-table tr:contains("Typ") td:last-child').text().trim();
      }

      // --- Genres ---
      const genreDd = ddForLabel($, genreLabels);
      let genres = genreDd ? genreDd.find('a').map((i, el) => $(el).text().trim()).get() : [];
      if (genres.length === 0 && genreDd) {
        genres = [genreDd.text().trim()].filter(Boolean);
      }
      if (genres.length === 0 && ld && ld.genre) {
        genres = [].concat(ld.genre).filter(Boolean);
      }
      if (genres.length === 0) {
        genres = $('.product-table tr:contains("Kategoria") td:last-child a')
          .map((i, el) => $(el).text().trim()).get();
      }
      console.log(`[${requestId}] Genres extracted: ${JSON.stringify(genres)}`);

      // --- Language ---
      const langDd = ddForLabel($, languageLabels);
      let bookLanguage = langDd ? langDd.text().trim() : '';
      if (!bookLanguage && ld && ld.inLanguage) {
        bookLanguage = String(ld.inLanguage);
      }
      console.log(`[${requestId}] Book language found: "${bookLanguage}"`);

      // Filter out non-Czech books for Czech users
      if (language === 'cz' && bookLanguage) {
        const langLower = bookLanguage.toLowerCase();
        if (!langLower.includes('čeština') && langLower !== 'cs') {
          console.log(`[${requestId}] Filtering out ${match.title} - language is "${bookLanguage}", not Czech`);
          return null;
        }
      }

      // --- Series ---
      const seriesDd = ddForLabel($, seriesLabels);
      let series = seriesDd ? seriesDd.find('a').map((i, el) => $(el).text().trim()).get() : [];
      if (series.length === 0) {
        series = $('[class*="collections_list__"] li a, .product-series a, .series-info a, .product-table tr:contains("Seria") td:last-child a')
          .map((i, el) => $(el).text().trim())
          .get();
      }

      // --- Rating ---
      let rating = parseFloat($('[class*="rating-badge_badgeContent__"]').first().text().trim().replace(',', '.')) || null;
      if (rating === null && ld && ld.aggregateRating && ld.aggregateRating.ratingValue !== undefined) {
        rating = parseFloat(ld.aggregateRating.ratingValue) || null;
      }
      if (rating === null) {
        rating = parseFloat($('.StarIcon__Label-sc-6cf2a375-2, .rating-value, .product-rating .value, .rating .value').text().trim()) || null;
      }

      // --- Description (HTML) ---
      // The page can contain several elements with a "description_description__" prefix
      // (e.g. a club-price note), so prefer the one inside the section with the
      // "Opis"/"Popis" header, then fall back to legacy selectors.
      let descriptionHtml = $('[class*="description_header__"]').first().parent()
        .find('[class*="description_description__"]').first().html();
      if (!descriptionHtml) {
        descriptionHtml = $('.description_description__6gcfq, .product-description, .book-description, .product-desc').html();
      }
      
      // Basic sanitization
      const sanitizedDescription = descriptionHtml
        ? descriptionHtml
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
        : '';

      let description = sanitizedDescription;
      if (addAudiotekaLinkToDescription) {
        const audioTekaLink = `<a href="${match.url}">Audioteka link</a>`;
        description = `${audioTekaLink}<br><br>${sanitizedDescription}`;
        console.log(`Audioteka link will be added to the description for ${match.title}`);
      }

      // Get main cover image - prefix selector with og:image / JSON-LD fallbacks
      const cover = cleanCoverUrl(
        $('img[class*="product-top_cover__"]').attr('src') ||
        $('meta[property="og:image"]').attr('content') ||
        (ld && typeof ld.image === 'string' ? ld.image : undefined) ||
        $('.product-cover img, .book-cover img, .product-image img').attr('src') ||
        match.cover
      );

      const languages = language === 'cz' 
        ? ['czech'] 
        : ['polish'];

      const fullMetadata = {
        ...match,
        cover,
        narrator: narrators,
        duration: durationInMinutes,
        publisher,
        description,
        type,
        genres,
        series: [],
        tags: series,
        rating,
        languages, 
        identifiers: {
          audioteka: match.id,
        },
      };

        console.log(`[${requestId}] Full metadata for ${match.title}:`, JSON.stringify(fullMetadata, null, 2));
      return fullMetadata;
    } catch (error) {
      // try to capture request-scoped info if available
      let requestId = 'req';
      if (arguments.length >= 2 && arguments[1]) requestId = arguments[1];
      console.error(`[${requestId}] Error fetching full metadata for ${match.title}:`, error.message, error.stack);
      return match;
    }
  }
}

const provider = new AudiotekaProvider();

app.get('/search', async (req, res) => {
  try {
    console.log('Received search request:', req.query);
    const query = req.query.query;
    const author = req.query.author;

    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    const results = await provider.searchBooks(query, author);
    
    // Format the response according to the OpenAPI specification
    const formattedResults = {
      matches: results.matches.map(book => ({
        title: book.title,
        subtitle: book.subtitle || undefined,
        author: book.authors.join(', '),
        narrator: book.narrator || undefined,
        publisher: book.publisher || undefined,
        publishedYear: book.publishedDate ? new Date(book.publishedDate).getFullYear().toString() : undefined,
        description: book.description || undefined,
        cover: book.cover || undefined,
        isbn: book.identifiers?.isbn || undefined,
        asin: book.identifiers?.asin || undefined,
        genres: book.genres || undefined,
        tags: book.tags || undefined,
        series: book.series ? book.series.map(seriesName => ({
          series: seriesName,
          sequence: undefined // Audioteka doesn't provide sequence numbers
        })) : undefined,
        language: book.languages && book.languages.length > 0 ? book.languages[0] : undefined,
        duration: book.duration // This will now be the value in minutes from getFullMetadata
      }))
    };

    console.log('Sending response:', JSON.stringify(formattedResults, null, 2));
    res.json(formattedResults);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`Audioteka provider listening on port ${port}, language: ${language}, add link to description: ${addAudiotekaLinkToDescription}`);
  console.log(`Metadata fetch concurrency: ${metadataConcurrency}`);
});
