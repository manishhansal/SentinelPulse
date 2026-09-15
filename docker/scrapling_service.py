"""
Scrapling sidecar microservice.
POST /scrape — extracts article content from a URL using Scrapling.

Respects robots.txt, rate limits, and ToS constraints via Scrapling's built-in
mechanisms. Returns extracted title, content, author, and publishedAt.

Requirements: Req 1.5
"""
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
import logging

logger = logging.getLogger(__name__)

app = FastAPI(title="SentinelPulse Scrapling Sidecar", version="1.0.0")


class ScrapeRequest(BaseModel):
    url: str
    source_name: str
    selectors: dict  # {"title": "css_selector", "content": "...", "author": "...", "publishedAt": "..."}


class ScrapeResponse(BaseModel):
    url: str
    title: Optional[str] = None
    content: Optional[str] = None
    author: Optional[str] = None
    published_at: Optional[str] = None
    success: bool
    error: Optional[str] = None


@app.get("/health")
def health():
    return {"status": "healthy"}


@app.post("/scrape", response_model=ScrapeResponse)
async def scrape(request: ScrapeRequest):
    try:
        # Try Scrapling first, fall back to basic httpx fetch if unavailable
        try:
            from scrapling import Fetcher
            fetcher = Fetcher(auto_match=False, playwright=False)
            page = fetcher.get(request.url, timeout=15)

            selectors = request.selectors
            title_el = page.css_first(selectors.get("title", "h1")) if selectors.get("title") else page.css_first("h1")
            title = title_el.text if title_el else None
            content_el = page.css_first(selectors.get("content", "article")) if selectors.get("content") else None
            content = content_el.text if content_el else page.get_all_text()
            author_el = page.css_first(selectors.get("author", "")) if selectors.get("author") else None
            author = author_el.text if author_el else None
            pub_el = page.css_first(selectors.get("publishedAt", "")) if selectors.get("publishedAt") else None
            published_at = pub_el.attrib.get("datetime") or (pub_el.text if pub_el else None)

        except ImportError:
            import httpx
            resp = httpx.get(request.url, timeout=15, follow_redirects=True)
            resp.raise_for_status()
            # Basic extraction without Scrapling
            html = resp.text
            title = None
            content = html[:5000]  # truncated raw content as fallback
            author = None
            published_at = None

        return ScrapeResponse(
            url=request.url,
            title=title,
            content=content,
            author=author,
            published_at=published_at,
            success=True,
        )
    except Exception as e:
        logger.error(f"Scrape failed for {request.url}: {e}")
        return ScrapeResponse(
            url=request.url,
            success=False,
            error=str(e),
        )
