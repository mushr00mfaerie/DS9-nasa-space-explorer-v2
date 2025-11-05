// Use this API key to fetch information from NASA
const API_KEY = 'rxGh3PrkmKBfA68AnQ4Cz1RABoa8OFW99sqchntP';

// Build the NASA APOD API URL for multiple items (use count to fetch several entries)
const buildApodUrl = (count = 9) =>
	`https://api.nasa.gov/planetary/apod?api_key=${API_KEY}&count=${count}`;

// Render a single APOD item into the gallery container.
// Shows image, title and date. Explanation is shown only in the modal.
const renderApodItem = (container, item) => {
	// Create a wrapper div for each item using the CSS class used in style.css
	const itemEl = document.createElement('div');
	itemEl.className = 'gallery-item'; // matches CSS

	// Use the image URL (fall back to hdurl if available), and show title + date only
	const imgSrc = item.url || item.hdurl || '';
	itemEl.innerHTML = `
		<img src="${imgSrc}" alt="${item.title}" />
		<h3>${item.title}</h3>
		<p><strong>${item.date}</strong></p>
	`;

	// Open modal when image is clicked
	const imgEl = itemEl.querySelector('img');
	if (imgEl) {
		imgEl.addEventListener('click', () => openModal(item));
	}

	container.appendChild(itemEl);
};

// Fetch APOD items and populate the gallery.
// Accepts count and optional references to button & container for UI feedback.
// This version tries the official API first; if that fails or returns no images,
// it falls back to scraping the APOD archive pages.
const fetchApod = async (count = 9, { button = null, container = null } = {}) => {
	if (button) button.disabled = true;

	// Show loading placeholder while we fetch
	if (container) {
		container.innerHTML = `
			<div class="placeholder">
				<div class="placeholder-icon">🔭</div>
				<p>Loading Space Images...</p>
			</div>
		`;
	}

	try {
		// Try official API first
		const response = await fetch(buildApodUrl(count));
		if (response.ok) {
			const data = await response.json();
			const items = Array.isArray(data) ? data : [data];
			const images = items.filter(i => i.media_type === 'image');

			if (images.length > 0) {
				// Clear placeholder and render results
				if (container) container.innerHTML = '';
				images.forEach(item => renderApodItem(container, item));
				console.log('NASA APOD items (API):', images);
				return; // success, return early
			}
		} else {
			console.warn('NASA API responded with status', response.status);
		}

		// Fallback: scrape the APOD archive pages (via a public CORS proxy)
		console.warn('Falling back to archive scraping (CORS or API limit).');
		const archiveItems = await fetchFromArchive(count);
		if (archiveItems.length === 0 && container) {
			container.innerHTML = '<p>No image results returned from archive.</p>';
		} else if (container) {
			container.innerHTML = '';
			archiveItems.forEach(item => renderApodItem(container, item));
		}
	} catch (error) {
		console.error('Error fetching APOD (API + archive fallback):', error);
		if (container) container.innerHTML = '<p>Error loading images.</p>';
	} finally {
		if (button) button.disabled = false;
	}
};

// Helper: fetch a URL through the AllOrigins CORS proxy and return text.
// We use a small, public proxy to avoid CORS blocking when scraping apod.nasa.gov.
const fetchThroughProxy = async (url) => {
	const proxy = 'https://api.allorigins.win/raw?url=';
	const proxied = `${proxy}${encodeURIComponent(url)}`;
	const resp = await fetch(proxied);
	if (!resp.ok) throw new Error(`Proxy fetch failed: ${resp.status}`);
	return resp.text();
};

// Parse the archive listing page and return the most recent N daily page URLs.
const parseArchiveList = (html) => {
	const parser = new DOMParser();
	const doc = parser.parseFromString(html, 'text/html');
	// On archivepixFull.html links to daily pages typically look like: <a href="ap240930.html">...
	const anchors = Array.from(doc.querySelectorAll('a'))
		.map(a => a.getAttribute('href'))
		.filter(h => h && /^ap\d+\.html$/.test(h));
	// Remove duplicates and preserve order, then reverse to get newest first
	const unique = Array.from(new Set(anchors));
	return unique.reverse().map(h => `https://apod.nasa.gov/apod/${h}`);
};

// Parse a daily APOD page HTML to extract first image src, title, date (from filename) and explanation text.
const parseDailyPage = (html, pageUrl) => {
	const parser = new DOMParser();
	const doc = parser.parseFromString(html, 'text/html');

	// Find the first useful <img> in the content (skip site chrome if any)
	const imgs = Array.from(doc.querySelectorAll('img'));
	let imgEl = imgs.find(img => {
		const src = img.getAttribute('src') || '';
		// skip very small or layout images (heuristic: skip if src contains 'logo' or starts with 'https://');
		return src && !/logo|icon|spacer/i.test(src);
	});
	if (!imgEl) imgEl = imgs[0] || null;
	if (!imgEl) return null;

	// Resolve relative image URL against base apod URL
	const rawSrc = imgEl.getAttribute('src');
	const imageUrl = new URL(rawSrc, pageUrl).href;

	// Title: prefer the first <b> element, else the document title
	const b = doc.querySelector('b');
	const title = (b && b.textContent.trim()) || (doc.title || '').trim();

	// Date: try to derive from the page filename (apYYMMDD.html)
	let date = '';
	try {
		const filename = pageUrl.split('/').pop(); // ap240930.html
		const m = filename.match(/^ap(\d{2})(\d{2})(\d{2})\.html$/);
		if (m) {
			const yy = m[1], mm = m[2], dd = m[3];
			const year = parseInt(yy, 10) < 50 ? `20${yy}` : `19${yy}`; // simple rule
			date = `${year}-${mm}-${dd}`;
		}
	} catch (e) {
		/* ignore */
	}

	// Explanation: join meaningful <p> tags (heuristic)
	const paragraphs = Array.from(doc.querySelectorAll('p'))
		.map(p => p.textContent && p.textContent.trim())
		.filter(t => t && t.length > 30); // only longer paragraphs likely explanations
	const explanation = paragraphs.join('\n\n') || '';

	return {
		url: imageUrl,
		title: title || 'NASA APOD',
		date: date || '',
		explanation
	};
};

// Fetch N recent items by scraping the archive pages (limiting per count).
// This is slower than API (fetches multiple pages), so keep count small.
const fetchFromArchive = async (count = 9) => {
	try {
		// Fetch the archive listing
		const archiveUrl = 'https://apod.nasa.gov/apod/archivepixFull.html';
		const html = await fetchThroughProxy(archiveUrl);
		const dailyUrls = parseArchiveList(html).slice(0, count); // newest first

		// Fetch each daily page and parse it
		const results = [];
		for (const url of dailyUrls) {
			try {
				const pageHtml = await fetchThroughProxy(url);
				const item = parseDailyPage(pageHtml, url);
				if (item && item.url) results.push(item);
			} catch (e) {
				console.warn('Failed to fetch/parse daily page', url, e);
			}
		}
		return results;
	} catch (error) {
		console.error('Archive fetch failed:', error);
		return [];
	}
};

// Modal open/close helpers
const openModal = (item) => {
	const modal = document.getElementById('modal');
	const modalImage = document.getElementById('modalImage');
	const modalTitle = document.getElementById('modalTitle');
	const modalDate = document.getElementById('modalDate');
	const modalExplanation = document.getElementById('modalExplanation');

	if (!modal || !modalImage) return;

	modalImage.src = item.hdurl || item.url || '';
	modalImage.alt = item.title || 'NASA APOD';
	modalTitle.textContent = item.title || '';
	modalDate.textContent = item.date || '';
	modalExplanation.textContent = item.explanation || '';

	modal.classList.add('open');
	modal.setAttribute('aria-hidden', 'false');
	// trap focus could be added later for accessibility
};

const closeModal = () => {
	const modal = document.getElementById('modal');
	const modalImage = document.getElementById('modalImage');
	if (!modal) return;
	modal.classList.remove('open');
	modal.setAttribute('aria-hidden', 'true');
	// remove image src to stop any large image downloads when closed
	if (modalImage) modalImage.src = '';
};

// Wire up button click after DOM is ready.
// Matches IDs used in index.html: button id="getImageBtn" and gallery id="gallery".

// Replace the previous DOMContentLoaded block with an init that runs immediately
const init = () => {
	const fetchBtn = document.getElementById('getImageBtn');
	const gallery = document.getElementById('gallery');

	if (!fetchBtn || !gallery) {
		console.warn('Add elements with ids "getImageBtn" (button) and "gallery" (container) to use the gallery fetch.');
		return;
	}

	// When clicked, fetch 9 images and populate the gallery (change count as desired).
	fetchBtn.addEventListener('click', () => {
		fetchApod(9, { button: fetchBtn, container: gallery });
	});

	// Modal close wiring
	const modal = document.getElementById('modal');
	const modalOverlay = document.getElementById('modalOverlay');
	const modalClose = document.getElementById('modalClose');

	if (modalOverlay) modalOverlay.addEventListener('click', closeModal);
	if (modalClose) modalClose.addEventListener('click', closeModal);

	// Close on Escape key
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') closeModal();
	});
};

// If DOM is still loading, wait; otherwise run immediately.
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
